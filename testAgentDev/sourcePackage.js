import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const STUBS = Object.freeze({
  claude: 'public/scripts/CLAUDE.md',
  codex: 'public/scripts/AGENTS.md',
  cursor: 'public/scripts/uclusion.mdc'
});
const SKILL_RELATIVE = 'public/scripts/skills/uclusion';
const STUB_START = '<!-- uclusion-workflow:v1 -->';
const STUB_END = '<!-- /uclusion-workflow:v1 -->';
const SKILL_END = '<!-- /uclusion-skill:v1 -->';
const REFERENCE_END = '<!-- /uclusion-skill-reference:v1 -->';
const PLACEHOLDER = '{{UCLUSION_CLI}}';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

function validateSource(root) {
  const metadata = { root, stubs: {}, skill: {} };
  for (const [client, relativePath] of Object.entries(STUBS)) {
    const sourcePath = path.join(root, relativePath);
    const bytes = readRequired(sourcePath);
    const text = bytes.toString('utf8');
    assert(text.includes(STUB_START) && text.includes(STUB_END),
      `${sourcePath} is missing resident workflow markers`);
    assert(text.includes(PLACEHOLDER), `${sourcePath} is missing ${PLACEHOLDER}`);
    metadata.stubs[client] = {
      relativePath,
      bytes: bytes.length,
      sha256: sha256(bytes)
    };
  }
  const skillRoot = path.join(root, SKILL_RELATIVE);
  const requiredSkillFiles = [
    'SKILL.md',
    path.join('references', 'pokes.md'),
    path.join('references', 'operations.md'),
    path.join('agents', 'openai.yaml')
  ];
  const actualSkillFiles = allRegularFiles(skillRoot);
  const expectedSkillFiles = requiredSkillFiles
    .map((relativePath) => relativePath.split(path.sep).join('/'))
    .sort();
  assert.deepStrictEqual(
    actualSkillFiles,
    expectedSkillFiles,
    `Shipped workflow skill must contain exactly ${JSON.stringify(expectedSkillFiles)}`
  );
  for (const relativePath of requiredSkillFiles) {
    const sourcePath = path.join(skillRoot, relativePath);
    const bytes = readRequired(sourcePath);
    const text = bytes.toString('utf8');
    if (relativePath === 'SKILL.md') {
      assert(text.trimEnd().endsWith(SKILL_END),
        `${sourcePath} does not end with ${SKILL_END}`);
    } else if (relativePath.startsWith(`references${path.sep}`)) {
      assert(text.trimEnd().endsWith(REFERENCE_END),
        `${sourcePath} does not end with ${REFERENCE_END}`);
    }
  }
  for (const relativePath of actualSkillFiles) {
    const bytes = readRequired(path.join(skillRoot, relativePath));
    metadata.skill[relativePath] = {
      bytes: bytes.length,
      sha256: sha256(bytes)
    };
  }
  return metadata;
}

function copySkillPackage(sourceRoot, targetRoot) {
  fs.cpSync(sourceRoot, targetRoot, { recursive: true, force: true });
}

export function inspectSourcePackage(webUiRoot) {
  return validateSource(path.resolve(webUiRoot));
}

export function stageSourcePackage({ webUiRoot, workspace, client, cliCommand }) {
  const sourceMetadata = validateSource(path.resolve(webUiRoot));
  const sourceStub = path.join(webUiRoot, STUBS[client]);
  const rendered = fs.readFileSync(sourceStub, 'utf8').split(PLACEHOLDER).join(cliCommand);
  assert(!rendered.includes(PLACEHOLDER), 'Rendered resident stub still has CLI placeholders');

  let stubTarget;
  let skillTarget;
  if (client === 'claude') {
    stubTarget = path.join(workspace, 'CLAUDE.md');
    skillTarget = path.join(workspace, '.claude', 'skills', 'uclusion');
  } else if (client === 'codex') {
    stubTarget = path.join(workspace, 'AGENTS.md');
    skillTarget = path.join(workspace, '.agents', 'skills', 'uclusion');
  } else if (client === 'cursor') {
    stubTarget = path.join(workspace, '.cursor', 'rules', 'uclusion.mdc');
    skillTarget = path.join(workspace, '.cursor', 'skills', 'uclusion');
  } else {
    throw new Error(`Unknown client ${client}`);
  }
  fs.mkdirSync(path.dirname(stubTarget), { recursive: true });
  fs.writeFileSync(stubTarget, rendered);
  copySkillPackage(path.join(webUiRoot, SKILL_RELATIVE), skillTarget);
  const stagedFiles = allRegularFiles(skillTarget);
  assert.deepStrictEqual(stagedFiles, Object.keys(sourceMetadata.skill),
    'Staged skill package differs from the recursively hashed source package');
  return {
    stubTarget,
    skillTarget,
    renderedStubSha256: sha256(Buffer.from(rendered)),
    skill: sourceMetadata.skill
  };
}
