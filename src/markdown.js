'use strict';

// Guide JSON -> shareable markdown. Also used for the .md download/export.

function approvalLabel(a) {
  if (a.required === true) return 'Approval / review required';
  if (a.required === 'conditional') return 'Approval required only in some cases';
  if (a.required === 'unknown') return 'Approval requirements unknown - not stated in the fetched sources';
  return 'No approval required to start (per the fetched sources)';
}

function guideToMarkdown(g) {
  const lines = [];
  lines.push(`# OAuth setup guide: ${g.app}`);
  lines.push('');
  lines.push(`_${g.summary}_`);
  lines.push('');
  lines.push(`- **Difficulty:** ${g.difficulty} (model estimate from a fixed rubric: steps, review, approval)`);
  lines.push(`- **Expected time/effort:** setup time not measured; approval wait: ${g.approval.typical_timeline}`);
  lines.push(`- **${approvalLabel(g.approval)}**${g.approval.notes ? ` - ${g.approval.notes}` : ''}`);
  if (g.console_url) lines.push(`- **Developer console:** ${g.console_url}`);
  lines.push(`- **Last checked:** ${g.last_checked}`);
  if (g.coverage) lines.push(`- **Evidence coverage:** ${['create_app','credentials','redirect_uri','scopes','approval','agent_human'].map((k) => `${k.replace(/_/g, ' ')}: ${g.coverage[k] && g.coverage[k].status === 'verified' ? 'quote found' : 'not found'}`).join('; ')}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  g.steps.forEach((s, i) => {
    const badge = s.verified ? 'source page fetched by server (not console-tested)' : 'no fetched source page backs this step';
    lines.push(`${i + 1}. **${s.title}** _(${badge})_`);
    if (s.detail) lines.push(`   ${s.detail}`);
    if (s.source) lines.push(`   Source: ${s.source}`);
  });
  if (g.nuances.length) {
    lines.push('');
    lines.push('## Nuances and gotchas');
    g.nuances.forEach((n) => lines.push(`- ${n}`));
  }
  lines.push('');
  lines.push('## What an agent can do for you (inferred split, not tested)');
  (g.agent_can_do || []).forEach((n) => lines.push(`- ${n}`));
  lines.push('');
  lines.push('## Where you need to take over');
  (g.human_must_do || []).forEach((n) => lines.push(`- ${n}`));
  lines.push('');
  lines.push('## Sources');
  (g.sources || []).forEach((s) => lines.push(`- [${s.title || s.url}](${s.url})`));
  lines.push('');
  return lines.join('\n');
}

module.exports = { guideToMarkdown };
