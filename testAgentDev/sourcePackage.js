import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const STUBS = Object.freeze({
  claude: 'public/scripts/CLAUDE.md',
  codex: 'public/scripts/AGENTS.md',
  cursor: 'public/scripts/uclusion.mdc'
});
const SKILL_PACKAGES = Object.freeze({
  uclusion: Object.freeze({
    relativePath: 'public/scripts/skills/uclusion',
    files: Object.freeze([
      'SKILL.md',
      'references/pokes.md',
      'references/operations.md',
      'agents/openai.yaml'
    ]),
    skillStart: '<!-- uclusion-skill:v1 -->',
    skillEnd: '<!-- /uclusion-skill:v1 -->',
    referenceStarts: Object.freeze({
      'references/pokes.md': '<!-- uclusion-skill-reference:v1 -->',
      'references/operations.md': '<!-- uclusion-skill-reference:v1 -->'
    }),
    referenceEnds: Object.freeze({
      'references/pokes.md': '<!-- /uclusion-skill-reference:v1 -->',
      'references/operations.md': '<!-- /uclusion-skill-reference:v1 -->'
    })
  }),
  'uclusion-design': Object.freeze({
    relativePath: 'public/scripts/skills/uclusion-design',
    files: Object.freeze([
      'SKILL.md',
      'references/examples.md',
      'agents/openai.yaml'
    ]),
    skillStart: '<!-- uclusion-design-skill:v1 -->',
    skillEnd: '<!-- /uclusion-design-skill:v1 -->',
    referenceStarts: Object.freeze({
      'references/examples.md': '<!-- uclusion-design-reference:v1 -->'
    }),
    referenceEnds: Object.freeze({
      'references/examples.md': '<!-- /uclusion-design-reference:v1 -->'
    })
  })
});
const STUB_START = '<!-- uclusion-workflow:v1 -->';
const STUB_END = '<!-- /uclusion-workflow:v1 -->';
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
  const metadata = { root, stubs: {}, skills: {} };
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
  for (const [name, specification] of Object.entries(SKILL_PACKAGES)) {
    const skillRoot = path.join(root, specification.relativePath);
    const expectedFiles = [...specification.files].sort();
    const actualFiles = allRegularFiles(skillRoot);
    assert.deepStrictEqual(actualFiles, expectedFiles,
      `Shipped ${name} skill must contain exactly ${JSON.stringify(expectedFiles)}`);
    const files = {};
    for (const relativePath of actualFiles) {
      const sourcePath = path.join(skillRoot, relativePath);
      const bytes = readRequired(sourcePath);
      const text = bytes.toString('utf8');
      const startMarker = relativePath === 'SKILL.md'
        ? specification.skillStart
        : specification.referenceStarts[relativePath];
      const endMarker = relativePath === 'SKILL.md'
        ? specification.skillEnd
        : specification.referenceEnds[relativePath];
      if (startMarker) {
        assert(text.includes(startMarker),
          `${sourcePath} does not contain ${startMarker}`);
      }
      if (endMarker) {
        assert(text.trimEnd().endsWith(endMarker),
          `${sourcePath} does not end with ${endMarker}`);
        assert(!startMarker || text.indexOf(startMarker) < text.lastIndexOf(endMarker),
          `${sourcePath} has misordered package markers`);
      }
      files[relativePath] = {
        bytes: bytes.length,
        sha256: sha256(bytes)
      };
    }
    metadata.skills[name] = files;
  }
  // Preserve the original single-package metadata for existing artifact
  // consumers while exposing both complete packages to new catalogs.
  metadata.skill = metadata.skills.uclusion;
  return metadata;
}

function copySkillPackage(sourceRoot, targetRoot) {
  fs.cpSync(sourceRoot, targetRoot, { recursive: true, force: true });
}

function assertStagedPackage(target, expectedFiles, name) {
  const stagedFiles = allRegularFiles(target);
  assert.deepStrictEqual(stagedFiles, Object.keys(expectedFiles),
    `Staged ${name} package differs from its recursively hashed source package`);
  for (const relativePath of stagedFiles) {
    const bytes = readRequired(path.join(target, relativePath));
    assert.deepStrictEqual({ bytes: bytes.length, sha256: sha256(bytes) },
      expectedFiles[relativePath],
      `Staged ${name}/${relativePath} bytes differ from the validated source`);
  }
}

export function inspectSourcePackage(webUiRoot) {
  return validateSource(path.resolve(webUiRoot));
}

export function stageSourcePackage({ webUiRoot, workspace, client, cliCommand }) {
  const sourceRoot = path.resolve(webUiRoot);
  const sourceMetadata = validateSource(sourceRoot);
  const sourceStub = path.join(sourceRoot, STUBS[client]);
  const rendered = fs.readFileSync(sourceStub, 'utf8').split(PLACEHOLDER).join(cliCommand);
  assert(!rendered.includes(PLACEHOLDER), 'Rendered resident stub still has CLI placeholders');

  let stubTarget;
  let skillsRoot;
  if (client === 'claude') {
    stubTarget = path.join(workspace, 'CLAUDE.md');
    skillsRoot = path.join(workspace, '.claude', 'skills');
  } else if (client === 'codex') {
    stubTarget = path.join(workspace, 'AGENTS.md');
    skillsRoot = path.join(workspace, '.agents', 'skills');
  } else if (client === 'cursor') {
    stubTarget = path.join(workspace, '.cursor', 'rules', 'uclusion.mdc');
    skillsRoot = path.join(workspace, '.cursor', 'skills');
  } else {
    throw new Error(`Unknown client ${client}`);
  }
  fs.mkdirSync(path.dirname(stubTarget), { recursive: true });
  fs.writeFileSync(stubTarget, rendered);
  const skills = {};
  for (const [name, specification] of Object.entries(SKILL_PACKAGES)) {
    const target = path.join(skillsRoot, name);
    copySkillPackage(path.join(sourceRoot, specification.relativePath), target);
    assertStagedPackage(target, sourceMetadata.skills[name], name);
    skills[name] = {
      target,
      files: sourceMetadata.skills[name]
    };
  }
  return {
    stubTarget,
    skills,
    skillTarget: skills.uclusion.target,
    renderedStubSha256: sha256(Buffer.from(rendered)),
    skill: sourceMetadata.skill
  };
}
