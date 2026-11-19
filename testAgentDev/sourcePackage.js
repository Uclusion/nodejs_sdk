import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SKILL_PATH = 'public/scripts/skills/uclusion';
const STUB_START = '<!-- uclusion-workflow:v1 -->';
const STUB_END = '<!-- /uclusion-workflow:v1 -->';
const PLACEHOLDER = '{{UCLUSION_CLI}}';
const LAYOUT_READER = fileURLToPath(new URL('./sourcePackageLayout.py', import.meta.url));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fingerprint(bytes) {
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function readRequired(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`Required shipped workflow asset is unavailable: ${filePath}`, {
      cause: error
    });
  }
}

function allRegularFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      throw new Error(`Shipped workflow package may not contain symlinks: ${absolute}`);
    }
    if (entry.isDirectory()) {
      files.push(...allRegularFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Shipped workflow package contains unsupported file type: ${absolute}`);
    }
  }
  return files.sort();
}

function readLayout(root, features) {
  const result = spawnSync('python3', [LAYOUT_READER, root, JSON.stringify(features)], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  assert.strictEqual(result.status, 0,
    `Cannot read the shipped installer inventory: ${result.error?.message || result.stderr}`);
  return JSON.parse(result.stdout);
}

function validateSource(root, layout) {
  const metadata = { root, stubs: {}, skills: {} };
  for (const [client, relativePath] of Object.entries(layout.stubs)) {
    const sourcePath = path.join(root, relativePath);
    const bytes = readRequired(sourcePath);
    const text = bytes.toString('utf8');
    assert(text.includes(STUB_START) && text.includes(STUB_END),
      `${sourcePath} is missing resident workflow markers`);
    assert(text.includes(PLACEHOLDER), `${sourcePath} is missing ${PLACEHOLDER}`);
    metadata.stubs[client] = { relativePath, ...fingerprint(bytes) };
  }
  const skillRoot = path.join(root, SKILL_PATH);
  const expectedFiles = [...layout.files].sort();
  for (const relative of expectedFiles) {
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'),
      `Installer package path escapes its skill: ${relative}`);
  }
  // README is the maintainer guide, deliberately excluded by the installer.
  const actualFiles = allRegularFiles(skillRoot).filter((name) =>
    name !== 'README.md' || expectedFiles.includes(name));
  assert.deepStrictEqual(actualFiles, expectedFiles,
    `Shipped uclusion skill must contain exactly the installer's package inventory`);
  const files = {};
  for (const relativePath of actualFiles) {
    const sourcePath = path.join(skillRoot, relativePath);
    const bytes = readRequired(sourcePath);
    const text = bytes.toString('utf8');
    if (relativePath.endsWith('.md')) {
      const marker = relativePath === 'SKILL.md' ? 'uclusion-skill' : 'uclusion-skill-reference';
      const start = `<!-- ${marker}:v1 -->`;
      const end = `<!-- /${marker}:v1 -->`;
      assert(text.includes(start), `${sourcePath} does not contain ${start}`);
      assert(text.trimEnd().endsWith(end), `${sourcePath} does not end with ${end}`);
      assert(text.indexOf(start) < text.lastIndexOf(end),
        `${sourcePath} has misordered package markers`);
    }
    files[relativePath] = fingerprint(bytes);
  }
  metadata.skills.uclusion = files;
  metadata.skill = files;
  return metadata;
}

export function inspectSourcePackage(webUiRoot) {
  const root = path.resolve(webUiRoot);
  return validateSource(root, readLayout(root, { workClaims: false, tokenAudit: false }));
}

export function stageSourcePackage({
  webUiRoot, workspace, client, cliCommand, workClaims = false, tokenAudit = false
}) {
  const sourceRoot = path.resolve(webUiRoot);
  const layout = readLayout(sourceRoot, { workClaims, tokenAudit });
  const sourceMetadata = validateSource(sourceRoot, layout);
  assert(Object.hasOwn(layout.stubs, client), `Unknown client ${client}`);
  const sourceStub = path.join(sourceRoot, layout.stubs[client]);
  const rendered = fs.readFileSync(sourceStub, 'utf8').split(PLACEHOLDER).join(cliCommand);
  assert(!rendered.includes(PLACEHOLDER), 'Rendered resident stub still has CLI placeholders');
  const destinations = {
    claude: ['CLAUDE.md', '.claude/skills'],
    codex: ['AGENTS.md', '.agents/skills'],
    cursor: ['.cursor/rules/uclusion.mdc', '.cursor/skills']
  };
  const [stub, skillsDirectory] = destinations[client];
  const stubTarget = path.join(workspace, stub);
  const target = path.join(workspace, skillsDirectory, 'uclusion');
  fs.mkdirSync(path.dirname(stubTarget), { recursive: true });
  fs.writeFileSync(stubTarget, rendered);
  const stagedFiles = {};
  for (const [relative, expectedSource] of Object.entries(sourceMetadata.skill)) {
    const source = readRequired(path.join(sourceRoot, SKILL_PATH, relative));
    assert.deepStrictEqual(fingerprint(source), expectedSource,
      `Source changed while staging uclusion/${relative}`);
    const bytes = Object.hasOwn(layout.renderedFeatures, relative)
      ? Buffer.from(layout.renderedFeatures[relative]) : source;
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    stagedFiles[relative] = fingerprint(bytes);
    assert.deepStrictEqual(fingerprint(readRequired(destination)), stagedFiles[relative],
      `Staged uclusion/${relative} differs from installer-rendered bytes`);
  }
  assert.deepStrictEqual(allRegularFiles(target), Object.keys(stagedFiles),
    'Staged uclusion package differs from the installer inventory');
  return {
    stubTarget,
    skills: { uclusion: { target, files: stagedFiles } },
    skillTarget: target,
    renderedStubSha256: sha256(Buffer.from(rendered)),
    skill: stagedFiles,
    sourceSkill: sourceMetadata.skill,
    features: { workClaims, tokenAudit }
  };
}
