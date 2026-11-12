import { LIMITS } from '@openboard/core';
import { useState } from 'react';
import { Icon } from '../ui/Icon.js';

/** Tags as removable chips plus an input: Enter or comma adds, Backspace on empty removes the last. */
export function TagsEditor({
  id,
  tags,
  onChange,
}: {
  id: string;
  tags: readonly string[];
  onChange: (tags: string[] | null) => void;
}) {
  const [input, setInput] = useState('');

  const add = (raw: string) => {
    const next = [...tags];
    for (const part of raw.split(',')) {
      const tag = part.trim().replace(/^#/, '').slice(0, LIMITS.tag);
      if (tag && !next.includes(tag) && next.length < LIMITS.tagsPerNode) next.push(tag);
    }
    setInput('');
    if (next.length !== tags.length) onChange(next);
  };

  const remove = (tag: string) => {
    const next = tags.filter((t) => t !== tag);
    onChange(next.length > 0 ? next : null);
  };

  return (
    <div className="tags-editor">
      {tags.map((tag) => (
        <span key={tag} className="tag tag-chip">
          {tag}
          <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => remove(tag)}>
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="tags-input"
        value={input}
        placeholder={tags.length ? 'Add tag' : 'Add tags, separated by commas'}
        disabled={tags.length >= LIMITS.tagsPerNode}
        onChange={(event) => {
          const value = event.target.value;
          if (value.includes(',')) add(value);
          else setInput(value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            add(input);
          } else if (event.key === 'Backspace' && input === '' && tags.length > 0) {
            remove(tags[tags.length - 1] as string);
          }
        }}
        onBlur={() => {
          if (input.trim()) add(input);
        }}
      />
    </div>
  );
}
