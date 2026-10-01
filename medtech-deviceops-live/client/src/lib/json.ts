export function formatJson(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value, null, 2) ?? 'null';
  }
  const source = value as Record<string, unknown>;
  const priority = ['questions', 'response', 'state', 'options', 'metadata'];
  const keys = Object.keys(source).sort(
    (left, right) => (priority.indexOf(left) + 1 || 99) - (priority.indexOf(right) + 1 || 99)
  );
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, source[key]])), null, 2);
}
