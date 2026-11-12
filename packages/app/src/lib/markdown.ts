/**
 * Markdown for node bodies. Rendering goes through markdown-it with raw HTML
 * disabled, so board content (which may come from any agent) cannot inject
 * markup; markdown-it also refuses `javascript:`, `vbscript:` and non-image
 * `data:` links.
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer nofollow');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Images from board content would load remote resources silently; show their alt text instead.
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const alt = token?.content || 'image';
  return `<span class="md-image">[${md.utils.escapeHtml(alt)}]</span>`;
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
