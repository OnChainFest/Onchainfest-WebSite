// ONCHAINFEST-LEGAL-03/04/06 · Deployment controls of the legal hub workflows (node:test, no
// dependencies):
//   .github/workflows/legal-hub.yml         BUILD: untrusted, no secrets, uploads the artifact
//   .github/workflows/legal-hub-deploy.yml  DEPLOY: workflow_run from the default branch,
//                                           verifies the artifact, deploys preview / production
//
//   node --test legal/test/*.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Comment lines removed: assertions are about configuration, not prose.
const read = (name) =>
  readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const BUILD = read('legal-hub.yml');
const DEPLOY = read('legal-hub-deploy.yml');

/** Top-level section of a workflow (text up to the next top-level key). */
const section = (text, key) =>
  text.match(new RegExp(`\\n${key}:([\\s\\S]*?)(?=\\n[a-z][\\w-]*:|$)`))?.[1];

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

/** Steps of a job, in order, as [name, text]. */
const steps = (job) =>
  job
    .split(/\n(?= {6}- )/)
    .slice(1)
    .map((chunk) => [
      chunk.match(/^ {6}- name: (.+)$/m)?.[1] ?? chunk.match(/uses: (\S+)/)?.[1],
      chunk,
    ]);
const step = (job, prefix) => steps(job).find(([name]) => name.startsWith(prefix))?.[1];
const index = (job, prefix) => steps(job).findIndex(([name]) => name.startsWith(prefix));

const { build } = jobs(BUILD);
const { preview, production } = jobs(DEPLOY);

describe('build workflow (untrusted)', () => {
  it('has a single build job and never deploys', () => {
    assert.deepEqual(Object.keys(jobs(BUILD)), ['build']);
    assert.doesNotMatch(BUILD, /\bvercel\b (pull|build|deploy)|environment:/);
  });

  it('receives no secrets and only a read-only token', () => {
    assert.doesNotMatch(BUILD, /secrets\./);
    assert.match(section(BUILD, 'permissions'), /^\s*contents: read\s*$/);
    assert.doesNotMatch(build, /permissions:/);
    assert.match(step(build, 'actions/checkout'), /persist-credentials: false/);
  });

  it('builds the PR head commit and labels the artifact with it', () => {
    assert.match(
      step(build, 'actions/checkout'),
      /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
    );
    assert.match(
      build,
      /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
    );
    assert.match(
      step(build, 'Package artifact'),
      /--sha "\$HEAD_SHA"[\s\S]*--run-id "\$GITHUB_RUN_ID"/,
    );
  });

  it('runs the tests, self-checks the package and uploads exactly one artifact', () => {
    assert.ok(index(build, 'Hub and workflow tests') < index(build, 'Build'));
    assert.ok(index(build, 'Artifact verification tests') < index(build, 'Package artifact'));
    assert.ok(index(build, 'Self-check') < index(build, 'Upload artifact'));
    const upload = step(build, 'Upload artifact');
    assert.match(upload, /uses: actions\/upload-artifact@v4/);
    assert.match(upload, /name: legal-hub-site/);
    assert.match(upload, /include-hidden-files: false/);
  });

  it('applies the first publishable gate on pushes when production is enabled', () => {
    const gate = step(build, 'Publishable gate');
    assert.match(
      gate,
      /if: github\.event_name == 'push' && vars\.LEGAL_HUB_PRODUCTION_ENABLED == 'true'/,
    );
    assert.match(gate, /--require-publishable/);
    assert.ok(index(build, 'Publishable gate') < index(build, 'Package artifact'));
  });
});

describe('deploy workflow (trusted)', () => {
  it('runs only on completion of the legal-hub build, never on PR or push events', () => {
    const on = section(DEPLOY, 'on');
    assert.match(on, /workflow_run:\s+workflows: \[legal-hub\]\s+types: \[completed\]/);
    assert.doesNotMatch(on, /pull_request|push|workflow_dispatch|schedule/);
  });

  it('starts with no token permissions and has exactly the preview and production jobs', () => {
    assert.match(DEPLOY, /\npermissions: \{\}\n/);
    assert.deepEqual(Object.keys(jobs(DEPLOY)), ['preview', 'production']);
    for (const job of [preview, production]) {
      assert.match(job, /\n {4}permissions:\n {6}actions: read\n {6}contents: read\n/);
    }
  });

  it('never uses the account-wide VERCEL_TOKEN or the old shared variable', () => {
    assert.doesNotMatch(DEPLOY + BUILD, /secrets\.VERCEL_TOKEN\b|LEGAL_HUB_DEPLOY_ENABLED/);
  });

  it('never runs repository build code', () => {
    assert.doesNotMatch(DEPLOY, /build\.mjs|npm (run|ci|test)|node --test|legal\/scripts/);
    assert.match(DEPLOY, /npm install --global --ignore-scripts "vercel@\$\{VERCEL_CLI_VERSION\}"/);
  });
});

describe('preview job', () => {
  const expr = condition(preview);

  it('runs only for its own variable and successful same-repository PR builds', () => {
    assert.match(expr, /^vars\.LEGAL_HUB_PREVIEW_ENABLED == 'true' &&/);
    assert.match(expr, /github\.event\.workflow_run\.conclusion == 'success'/);
    assert.match(expr, /github\.event\.workflow_run\.event == 'pull_request'/);
    assert.match(
      expr,
      /github\.event\.workflow_run\.path == '\.github\/workflows\/legal-hub\.yml'/,
    );
    assert.match(expr, /workflow_run\.head_repository\.full_name == github\.repository/);
    assert.doesNotMatch(expr, /PRODUCTION|\|\|/);
  });

  it('cannot deploy to production', () => {
    assert.doesNotMatch(
      preview,
      /--prod\b|legal-hub-production|--mode production|--target production/,
    );
    assert.match(preview, /\n {4}environment: legal-hub-preview\n/);
  });

  it('refuses to deploy into a project without a production deployment or protection', () => {
    const guard = step(preview, 'Guard preview target');
    assert.match(guard, /api\.vercel\.com\/v9\/projects\/\$VC_PROJECT/);
    assert.match(guard, /artifact\.py check-project/);
    assert.ok(index(preview, 'Verify prebuilt output') < index(preview, 'Guard preview target'));
    assert.ok(index(preview, 'Guard preview target') < index(preview, 'Deploy'));
  });

  it('checks out only trusted tooling from the default branch', () => {
    const checkout = step(preview, 'Check out trusted tooling');
    assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(checkout, /persist-credentials: false/);
    assert.match(
      checkout,
      /sparse-checkout: \|\n {12}\.github\/legal-hub\n {12}legal\/vercel\.json\n {12}\.nvmrc\n/,
    );
  });
});

describe('production job', () => {
  const expr = condition(production);

  it('runs only for its own variable and successful push builds of main', () => {
    assert.match(expr, /^vars\.LEGAL_HUB_PRODUCTION_ENABLED == 'true' &&/);
    assert.match(expr, /github\.event\.workflow_run\.event == 'push'/);
    assert.match(expr, /github\.event\.workflow_run\.head_branch == 'main'/);
    assert.match(expr, /workflow_run\.head_repository\.full_name == github\.repository/);
    assert.doesNotMatch(expr, /PREVIEW|\|\|/);
  });

  it('requires the protected environment and refuses without reviewers, before anything else', () => {
    assert.match(production, /\n {4}environment: legal-hub-production\n/);
    assert.equal(index(production, 'Guard environment protection'), 0);
    assert.match(
      step(production, 'Guard environment protection'),
      /index\("required_reviewers"\) != null/,
    );
  });

  it('deploys only a commit that is on main, checked before it is checked out', () => {
    const guard = step(production, 'Guard commit is on main');
    assert.match(guard, /compare\/\$HEAD_SHA\.\.\.\$GITHUB_SHA/);
    assert.match(guard, /identical\|ahead\)/);
    assert.ok(
      index(production, 'Guard commit is on main') < index(production, 'Check out trusted tooling'),
    );
    assert.match(
      step(production, 'Check out trusted tooling'),
      /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
    );
  });

  it('has no preview-target guard (production is the intended target)', () => {
    assert.equal(index(production, 'Guard preview target'), -1);
  });

  it('verifies the artifact with production rules (second legal gate)', () => {
    assert.match(step(production, 'Fetch and verify'), /--mode "\$MODE"/);
    assert.match(production, /\n {6}MODE: production\n/);
    assert.match(step(production, 'Build prebuilt output'), /vercel build --prod --yes/);
    assert.match(step(production, 'Verify prebuilt output'), /--target production/);
  });
});

describe('deploy job procedure (both jobs)', () => {
  for (const [id, job] of [
    ['preview', preview],
    ['production', production],
  ]) {
    it(`${id}: environment guard restricts deployments to main`, () => {
      const guard = step(job, 'Guard environment protection');
      assert.match(guard, /custom_branch_policies/);
      assert.match(guard, /"\$branches" != "branch:main"/);
    });

    it(`${id}: the artifact must be this run's, this commit's and match GitHub's digest`, () => {
      const fetch = step(job, 'Fetch and verify');
      assert.match(fetch, /actions\/runs\/\$RUN_ID\/artifacts/);
      assert.match(fetch, /\.workflow_run\.id' <<<"\$meta"\)" = "\$RUN_ID"/);
      assert.match(fetch, /\.workflow_run\.head_sha' <<<"\$meta"\)" = "\$HEAD_SHA"/);
      assert.match(fetch, /--digest "\$digest"/);
      assert.match(fetch, /artifact\.py verify/);
    });

    it(`${id}: steps run in a fail-closed order`, () => {
      const order = [
        'Guard environment protection',
        'Check out trusted tooling',
        'Fetch and verify',
        'Prepare deploy workspace',
        'Install Vercel CLI',
        'Guard target project',
        'Pull Vercel project settings',
        'Guard project link',
        'Build prebuilt output',
        'Verify prebuilt output',
        'Deploy',
        'Verify deployment',
      ].map((prefix) => index(job, prefix));
      assert.ok(
        order.every((i) => i >= 0),
        `missing step: ${order}`,
      );
      assert.deepEqual(
        [...order].sort((a, b) => a - b),
        order,
      );
    });

    it(`${id}: the Vercel token only on pull, deploy and its API checks; build without a token`, () => {
      const withToken = ['Pull Vercel', 'Guard preview target', 'Deploy', 'Verify deployment'];
      for (const [name, text] of steps(job)) {
        const allowed = withToken.some((prefix) => name.startsWith(prefix));
        assert.equal(/VERCEL_LEGAL_TOKEN/.test(text), allowed, name);
      }
      assert.doesNotMatch(step(job, 'Build prebuilt output'), /--token|secrets\./);
      assert.doesNotMatch(job.slice(0, job.indexOf('\n    steps:\n')), /secrets\./);
    });

    it(`${id}: reads the deployment back and checks its server-side target`, () => {
      const deploy = step(job, 'Deploy');
      assert.match(deploy, /\n {8}id: deploy\n/);
      assert.match(deploy, /echo "url=\$url" >> "\$GITHUB_OUTPUT"/);
      const verify = step(job, 'Verify deployment');
      assert.match(verify, /DEPLOYMENT_URL: \$\{\{ steps\.deploy\.outputs\.url \}\}/);
      assert.match(verify, /\/v13\/deployments\//);
      assert.match(verify, /\/v2\/deployments\/\$id\/aliases/);
      assert.match(verify, /artifact\.py check-deployment[\s\S]*--mode "\$MODE"/);
      // The only tolerated failure is an anonymous probe's (an error there is reported as 000).
      const outsideProbe = verify.replace(/result=\$\(curl [^)]*\)/, '');
      assert.doesNotMatch(outsideProbe, /\|\|\s*(true|:)|set \+e/);
      assert.match(verify, /set -euo pipefail/);
      assert.doesNotMatch(job, /continue-on-error/);
    });

    it(`${id}: probes every URL of a preview without credentials`, () => {
      const verify = step(job, 'Verify deployment');
      const probe = verify.match(/result=\$\(curl [^)]*\)/)?.[0];
      assert.ok(probe, 'anonymous probe');
      assert.doesNotMatch(probe, /TOKEN|Authorization|bypass/i);
      assert.match(verify, /\.aliases\[\]\?\.alias/);
      assert.match(verify, /if \[ "\$MODE" = preview \]/);
    });

    it(`${id}: never deletes or re-aliases deployments automatically`, () => {
      assert.doesNotMatch(job, /vercel (remove|rm|alias|promote|rollback)|-X DELETE/);
    });

    it(`${id}: project ids are checked before the pull and the link after it`, () => {
      assert.match(step(job, 'Guard target project'), /artifact\.py check-ids/);
      assert.match(step(job, 'Guard project link'), /artifact\.py check-link/);
      assert.match(
        step(job, 'Guard project link'),
        /VC_WEBSITE_PROJECT: \$\{\{ secrets\.VERCEL_PROJECT_ID \}\}/,
      );
    });
  }
});
