// ONCHAINFEST-LEGAL-03 · Deployment controls of .github/workflows/legal-hub.yml (node:test, no
// dependencies): independent preview/production variables, the production environment and
// gates, and where the Vercel token is (and is not) available.
//
//   node --test legal/test/*.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Comment lines removed: assertions are about configuration, not prose.
const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/legal-hub.yml', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** The text of each job under `jobs:`, keyed by job id (2-space indented keys). */
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const result = {};
  for (const chunk of body.split(/\n(?= {2}[a-z][\w-]*:\n)/)) {
    const id = chunk.match(/^ {2}([a-z][\w-]*):/)?.[1];
    if (id) result[id] = chunk;
  }
  return result;
}

/** The job's `if:` expression, folded onto one line. */
const condition = (job) =>
  (job.match(/\n {4}if: >-\n((?: {6}.*\n?)+)/)?.[1] ?? '').replace(/\s+/g, ' ').trim();

/** Steps of a job, keyed by name. */
function steps(job) {
  const result = {};
  for (const chunk of job.split(/\n(?= {6}- )/).slice(1)) {
    const name = chunk.match(/^ {6}- name: (.+)$/m)?.[1] ?? chunk.match(/uses: (\S+)/)?.[1];
    result[name] = chunk;
  }
  return result;
}

const { check, preview, production } = jobs(WORKFLOW);

describe('deployment controls', () => {
  it('has exactly the check, preview and production jobs', () => {
    assert.deepEqual(Object.keys(jobs(WORKFLOW)), ['check', 'preview', 'production']);
  });

  it('no longer uses the shared LEGAL_HUB_DEPLOY_ENABLED variable', () => {
    assert.doesNotMatch(WORKFLOW, /LEGAL_HUB_DEPLOY_ENABLED/);
  });

  it('gates the preview on its own variable only, for same-repository pull requests', () => {
    const expr = condition(preview);
    assert.match(expr, /github\.event_name == 'pull_request'/);
    assert.match(expr, /vars\.LEGAL_HUB_PREVIEW_ENABLED == 'true'/);
    assert.match(expr, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
    assert.doesNotMatch(expr, /PRODUCTION|\|\|/);
  });

  it('gates production on its own variable only, for pushes to main', () => {
    const expr = condition(production);
    assert.match(expr, /github\.event_name == 'push'/);
    assert.match(expr, /github\.ref == 'refs\/heads\/main'/);
    assert.match(expr, /vars\.LEGAL_HUB_PRODUCTION_ENABLED == 'true'/);
    assert.doesNotMatch(expr, /PREVIEW|\|\|/);
  });

  it('compares both variables to the literal string true, so an undefined variable is off', () => {
    for (const expr of [condition(preview), condition(production)]) {
      const uses = expr.match(/vars\.LEGAL_HUB_\w+ == '[^']*'/g);
      assert.equal(uses.length, 1);
      assert.match(uses[0], /== 'true'$/);
    }
  });

  it('never deploys to production from a pull request', () => {
    assert.doesNotMatch(preview, /--prod\b/);
    assert.match(condition(production), /^github\.event_name == 'push' &&/);
  });

  it('runs production in the legal-hub-production environment and fails without reviewers', () => {
    assert.match(production, /\n {4}environment: legal-hub-production\n/);
    assert.doesNotMatch(preview, /environment:/);
    const names = Object.keys(steps(production));
    const guard = names.indexOf('Guard environment protection (required reviewers)');
    assert.ok(guard >= 0, 'environment guard step');
    assert.match(steps(production)[names[guard]], /index\("required_reviewers"\) != null/);
    assert.ok(
      guard < names.findIndex((n) => n.startsWith('Pull Vercel')),
      'guard before any token',
    );
  });

  it('applies the publishable gate before the token is used, and again inside the build', () => {
    const s = steps(production);
    const names = Object.keys(s);
    const gate = names.indexOf('Publishable gate (no drafts, no open review markers)');
    assert.ok(gate >= 0 && gate < names.findIndex((n) => n.startsWith('Pull Vercel')));
    assert.match(s[names[gate]], /node scripts\/build\.mjs --require-publishable/);
    const build = s['Build (production, no token)'];
    assert.match(build, /VERCEL_ENV: production/);
    assert.match(build, /vercel build --prod/);
  });
});

describe('credential isolation', () => {
  it('gives the check job no secrets', () => {
    assert.doesNotMatch(check, /secrets\./);
  });

  it('defines no secrets at workflow level', () => {
    assert.doesNotMatch(WORKFLOW.slice(0, WORKFLOW.indexOf('\njobs:\n')), /secrets\./);
  });

  for (const [id, job] of [
    ['preview', preview],
    ['production', production],
  ]) {
    it(`${id}: VERCEL_TOKEN only on the pull and deploy steps`, () => {
      const jobLevel = job.slice(0, job.indexOf('\n    steps:\n'));
      assert.doesNotMatch(jobLevel, /VERCEL_TOKEN/);
      for (const [name, step] of Object.entries(steps(job))) {
        const allowed = name.startsWith('Pull Vercel') || name.startsWith('Deploy');
        assert.equal(/VERCEL_TOKEN/.test(step), allowed, `${name}`);
        if (allowed) assert.match(step, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/);
      }
    });

    it(`${id}: builds without a token and keeps the project and artifact guards`, () => {
      const s = steps(job);
      const build = Object.entries(s).find(([name]) => name.startsWith('Build'))[1];
      assert.doesNotMatch(build, /--token|--project|--scope/);
      assert.match(s['Guard target project'], /"\$VC_PROJECT" = "\$VC_WEBSITE_PROJECT"/);
      assert.match(s['Guard pulled project link'], /rootDirectory/);
      assert.match(s['Verify artifact contains only the legal hub'], /oncf-site/);
    });
  }
});
