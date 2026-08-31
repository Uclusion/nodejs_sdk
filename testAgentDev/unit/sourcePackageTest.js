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
  write(path.join(scripts, 'CLAUDE.md'), stub);
  write(path.join(scripts, 'AGENTS.md'), stub);
  write(path.join(scripts, 'uclusion.mdc'), `---\nalwaysApply: true\n---\n${stub}`);
  write(path.join(scripts, 'skills', 'uclusion', 'SKILL.md'),
    '---\nname: uclusion\ndescription: test\n---\n' +
    '<!-- uclusion-skill:v1 -->\n<!-- /uclusion-skill:v1 -->\n');
  write(path.join(scripts, 'skills', 'uclusion', 'references', 'pokes.md'),
    '<!-- uclusion-skill-reference:v1 -->\n# Pokes\n' +
    '<!-- /uclusion-skill-reference:v1 -->\n');
  write(path.join(scripts, 'skills', 'uclusion', 'references', 'operations.md'),
    '<!-- uclusion-skill-reference:v1 -->\n# Operations\n' +
    '<!-- /uclusion-skill-reference:v1 -->\n');
  write(path.join(scripts, 'skills', 'uclusion', 'agents', 'openai.yaml'),
    'interface:\n  display_name: Uclusion\n');
  write(path.join(scripts, 'skills', 'uclusion-design', 'SKILL.md'),
    '---\nname: uclusion-design\ndescription: test\n---\n' +
    '<!-- uclusion-design-skill:v1 -->\n<!-- /uclusion-design-skill:v1 -->\n');
  write(path.join(scripts, 'skills', 'uclusion-design', 'references', 'examples.md'),
    '<!-- uclusion-design-reference:v1 -->\n# Examples\n' +
    '<!-- /uclusion-design-reference:v1 -->\n');
  write(path.join(scripts, 'skills', 'uclusion-design', 'agents', 'openai.yaml'),
    'interface:\n  display_name: Uclusion Design\n');
}

describe('agent dev shipped source staging', () => {
  it('validates EOF sentinels and stages each exact client-native path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-source-unit-'));
    sourceTree(root);
    const inspected = inspectSourcePackage(root);
    assert.deepStrictEqual(Object.keys(inspected.stubs), ['claude', 'codex', 'cursor']);
    for (const client of ['claude', 'codex', 'cursor']) {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `agent-${client}-unit-`));
      const staged = stageSourcePackage({
        webUiRoot: root,
        workspace,
        client,
        cliCommand: '/tmp/uclusion-dev -e dev'
      });
      assert(fs.existsSync(staged.stubTarget));
      assert(fs.existsSync(path.join(staged.skillTarget, 'SKILL.md')));
      assert(!fs.readFileSync(staged.stubTarget, 'utf8').includes('{{UCLUSION_CLI}}'));
      assert(fs.readFileSync(staged.stubTarget, 'utf8').includes('/tmp/uclusion-dev -e dev'));
    }
  });

  it('fails closed when a reference is truncated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-source-unit-'));
    sourceTree(root);
    write(path.join(root, 'public', 'scripts', 'skills', 'uclusion',
      'references', 'pokes.md'), '# truncated\n');
    assert.throws(() => inspectSourcePackage(root), /does not end/);
  });

  it('rejects extra skill files rather than silently exposing them to live agents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-source-unit-'));
    sourceTree(root);
    const extra = path.join(root, 'public', 'scripts', 'skills', 'uclusion',
      'assets', 'nested', 'example.txt');
    write(extra, 'extra shipped bytes\n');
    assert.throws(() => inspectSourcePackage(root), /must contain exactly/);
  });
});
