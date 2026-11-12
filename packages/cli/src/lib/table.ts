import { type Output, println } from './io.js';

export interface Column<T> {
  header: string;
  value: (row: T) => string | number;
  /** Right-align (for numbers). */
  right?: boolean;
}

/** Print rows as space-separated, aligned columns with a header line. */
export function printTable<T>(
  out: Output,
  rows: readonly T[],
  columns: readonly Column<T>[],
): void {
  const cells = rows.map((row) => columns.map((column) => String(column.value(row))));
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...cells.map((line) => line[i]?.length ?? 0)),
  );
  const format = (line: readonly string[]) =>
    line
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        return columns[i]?.right ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();
  println(out, format(columns.map((c) => c.header)));
  for (const line of cells) println(out, format(line));
}
