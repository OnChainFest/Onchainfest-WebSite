import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/vercel-deploy.yml', import.meta.url),
  'utf8',
);
const condition = (job: string) => {
  const section = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z]+:\n/)[0];
  const expression = section?.match(/^    if: (.+)$/m)?.[1];
  if (expression === undefined) throw new Error('missing deployment condition');
  return expression;
};
const evaluate = (expression: string, context: Record<string, string>) =>
  expression.split(' && ').every((term) => {
    const match = /^(github\.[a-z_.]+) (==|!=) '([^']*)'$/.exec(term);
    if (match === null) throw new Error('unsupported deployment guard expression');
    const [, key, operator, literal] = match;
    return operator === '==' ? context[key!] === literal : context[key!] !== literal;
  });

describe('D-13 CI-only deployment isolation', () => {
  const branch = 'fix/oncf-wp-p0-4-advancement-preflight';
  it('never runs preview or production for this branch push or PR creation/update', () => {
    for (const event of ['push', 'pull_request']) {
      const context = {
        'github.event_name': event,
        'github.head_ref': event === 'pull_request' ? branch : '',
        'github.ref': event === 'push' ? `refs/heads/${branch}` : 'refs/pull/123/merge',
      };
      expect(evaluate(condition('preview'), context)).toBe(false);
      expect(evaluate(condition('production'), context)).toBe(false);
    }
  });
  it('preserves other previews and the existing production guard', () => {
    expect(
      evaluate(condition('preview'), {
        'github.event_name': 'pull_request',
        'github.head_ref': 'feature/other',
      }),
    ).toBe(true);
    expect(condition('production')).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(
      evaluate(condition('production'), {
        'github.event_name': 'push',
        'github.ref': 'refs/heads/main',
      }),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).git
        .deploymentEnabled,
    ).toBe(false);
  });
});
