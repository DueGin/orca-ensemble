// Orca checks every value that crosses to the host as JSON: a panel's request input, a worker's answer, stored data.
// An `undefined` inside an object fails that check with "Invalid input". Editor drafts and zod output keep unset optional
// fields (a candidate's model, the team's language) as `undefined` keys, so values are made plain JSON before they cross.
export function toJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
