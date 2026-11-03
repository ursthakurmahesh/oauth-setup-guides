'use strict';

// Guide JSON -> shareable markdown. Also used for the .md download/export.

function approvalLabel(a) {
  if (a.required === true) return 'Approval / review required';
  if (a.required === 'conditional') return 'Approval required only in some cases';
  return 'No approval required to start';
}

function guideToMarkdown(g) {
  const lines = [];
  lines.push(`# OAuth setup guide: ${g.app}`);
  lines.push('');
  lines.push(`_${g.summary}_`);
  lines.push('');
  lines.push(`- **Difficulty:** ${g.difficulty}`);
  lines.push(`- **Expected time/effort:** ${g.approval.typical_timeline}`);
  lines.push(`- **${approvalLabel(g.approval)}**${g.approval.notes ? ` - ${g.approval.notes}` : ''}`);
  if (g.console_url) lines.push(`- **Developer console:** ${g.console_url}`);
  lines.push(`- **Last checked:** ${g.last_checked}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  g.steps.forEach((s, i) => {
    const badge = s.verified ? 'checked against source' : 'NOT independently verified';
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
  lines.push('## What an agent can do for you');
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
