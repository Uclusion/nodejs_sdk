import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inspectSourcePackage, stageSourcePackage } from '../sourcePackage.js';

function write(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function sourceTree(root) {
  const scripts = path.join(root, 'public', 'scripts');
  const stub = '<!-- uclusion-workflow:v1 -->\n{{UCLUSION_CLI}} wait\n' +
    '<!-- /uclusion-workflow:v1 -->\n';
  for (const name of ['CLAUDE.template.md', 'AGENTS.template.md', 'uclusion.mdc']) {
    write(path.join(scripts, name), stub);
  }
  const files = ['SKILL.md', 'roles/design.md', 'references/coordinator-lifecycle.md',
    'references/completion.md', 'references/claims.md', 'references/audit.md',
    'agents/openai.yaml'];
  for (const name of files) {
    const marker = name === 'SKILL.md' ? 'uclusion-skill' : 'uclusion-skill-reference';
    const body = name === 'references/claims.md' ? '{{CLAIMS}}' :
      name === 'references/audit.md' ? '{{AUDIT}}' : name;
    write(path.join(scripts, 'skills/uclusion', name), name.endsWith('.md')
      ? `<!-- ${marker}:v1 -->\n${body}\n<!-- /${marker}:v1 -->\n`
      : 'interface:\n  display_name: Uclusion\n');
  }
  write(path.join(scripts, 'skills/uclusion/README.md'), 'Maintainer-only guide.\n');
  write(path.join(scripts, 'uclusionInstall.py'),
    `CLIENT_STUB_ASSET = {'claude': 'claude_stub', 'codex': 'codex_stub', 'cursor': 'cursor_stub'}\n` +
    `WORKFLOW_ASSET_PATHS = {'claude_stub': 'CLAUDE.template.md', ` +
    `'codex_stub': 'AGENTS.template.md', 'cursor_stub': 'uclusion.mdc', ` +
    `'claims_reference': 'skills/uclusion/references/claims.md', ` +
    `'audit_reference': 'skills/uclusion/references/audit.md'}\n` +
    `SKILL_PACKAGE_ASSETS = [(name, name) for name in ${JSON.stringify(files)}]\n` +
    'def render_feature_reference(text, key, enabled):\n' +
    '    marker = "{{CLAIMS}}" if key == "claims_reference" else "{{AUDIT}}"\n' +
    '    return text.replace(marker, "enabled" if enabled else "disabled")\n');
}

describe('agent dev shipped source staging', () => {
  const roots = [];
  function temp(prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('stages the installer inventory at every native client path and excludes its maintainer guide', () => {
    const root = temp('agent-source-unit-');
    sourceTree(root);
    const inspected = inspectSourcePackage(root);
    assert.deepStrictEqual(Object.keys(inspected.stubs), ['claude', 'codex', 'cursor']);
    for (const client of ['claude', 'codex', 'cursor']) {
      const staged = stageSourcePackage({
        webUiRoot: root, workspace: temp(`agent-${client}-unit-`), client,
        cliCommand: '/tmp/uclusion-dev -e dev'
      });
      assert(fs.readFileSync(staged.stubTarget, 'utf8').includes('/tmp/uclusion-dev -e dev'));
      assert(!fs.readFileSync(staged.stubTarget, 'utf8').includes('{{UCLUSION_CLI}}'));
      assert(fs.existsSync(path.join(staged.skillTarget, 'references/coordinator-lifecycle.md')));
      assert(!fs.existsSync(path.join(staged.skillTarget, 'README.md')));
      assert.deepStrictEqual(staged.skill['roles/design.md'], inspected.skill['roles/design.md']);
    }
  });

  it('follows a newly packaged role without a second maintained inventory', () => {
    const root = temp('agent-source-unit-');
    sourceTree(root);
    const scripts = path.join(root, 'public/scripts');
    write(path.join(scripts, 'skills/uclusion/roles/new-role.md'),
      '<!-- uclusion-skill-reference:v1 -->\nNew role\n<!-- /uclusion-skill-reference:v1 -->\n');
    fs.appendFileSync(path.join(scripts, 'uclusionInstall.py'),
      'SKILL_PACKAGE_ASSETS.append(("new_role", "roles/new-role.md"))\n');
    const staged = stageSourcePackage({
      webUiRoot: root, workspace: temp('agent-new-role-'), client: 'codex', cliCommand: 'uclusion -e dev'
    });
    assert(fs.existsSync(path.join(staged.skillTarget, 'roles/new-role.md')));
  });

  it('renders actual feature settings with the installer while retaining source and staged hashes', () => {
    const root = temp('agent-source-unit-');
    sourceTree(root);
    for (const enabled of [false, true]) {
      const staged = stageSourcePackage({
        webUiRoot: root, workspace: temp('agent-features-'), client: 'codex',
        cliCommand: 'uclusion -e dev', workClaims: enabled, tokenAudit: enabled
      });
      for (const name of ['claims', 'audit']) {
        const relative = `references/${name}.md`;
        const body = fs.readFileSync(path.join(staged.skillTarget, relative), 'utf8');
        assert(body.includes(enabled ? '\nenabled\n' : '\ndisabled\n'));
        assert(!body.includes('{{'));
        assert.notStrictEqual(staged.sourceSkill[relative].sha256, staged.skill[relative].sha256);
      }
      assert.deepStrictEqual(staged.sourceSkill['references/coordinator-lifecycle.md'],
        staged.skill['references/coordinator-lifecycle.md']);
    }
  });

  it('fails closed when a reference is truncated', () => {
    const root = temp('agent-source-unit-');
    sourceTree(root);
    write(path.join(root, 'public/scripts/skills/uclusion/references/completion.md'),
      '<!-- uclusion-skill-reference:v1 -->\n# truncated\n');
    assert.throws(() => inspectSourcePackage(root), /does not end/);
  });

  it('rejects unlisted files instead of exposing them to live agents', () => {
    const root = temp('agent-source-unit-');
    sourceTree(root);
    write(path.join(root, 'public/scripts/skills/uclusion/assets/nested/example.txt'), 'extra bytes\n');
    assert.throws(() => inspectSourcePackage(root), /must contain exactly/);
  });
});
