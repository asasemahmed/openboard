/** The templates the server offers (`GET /api/templates`), read on first use. */
import type { TemplateSummary } from '@openboard/core';
import { api } from './boards.js';
import { useValue, Value } from './emitter.js';

export const templateList = new Value<TemplateSummary[] | null>(null);

let loading: Promise<TemplateSummary[]> | null = null;

/** The list, from the server the first time and from memory after. Rejects when the server cannot say. */
export function loadTemplates(fresh = false): Promise<TemplateSummary[]> {
  if (fresh) loading = null;
  loading ??= api.templates().then(
    (list) => {
      templateList.set(list);
      return list;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

export function useTemplateList(): TemplateSummary[] | null {
  return useValue(templateList);
}
