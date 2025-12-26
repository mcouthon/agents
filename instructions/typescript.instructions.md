---
applyTo: "**/*.{ts,tsx}"
---

# TypeScript Coding Standards

## Type System

- Enable `strict: true` in tsconfig
- Avoid `any` - use `unknown` when type is truly unknown
- Prefer interfaces for object shapes, types for unions/intersections
- Use const assertions for literal types

```typescript
// Good
interface User {
  id: string;
  email: string;
  role: "admin" | "user";
}

const STATUS = {
  pending: "pending",
  complete: "complete",
} as const;

type Status = (typeof STATUS)[keyof typeof STATUS];

// Avoid
const user: any = fetchUser();
```

## Nullability

- Use strict null checks
- Prefer `undefined` over `null` for optional values
- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Avoid non-null assertions (`!`) except when type system is wrong

```typescript
// Good
const name = user?.profile?.displayName ?? "Anonymous";

// Avoid
const name = user!.profile!.displayName || "Anonymous";
```

## Functions

- Always type parameters and return values
- Use arrow functions for callbacks
- Prefer async/await over raw promises
- Use function overloads sparingly

```typescript
// Good
async function fetchUser(id: string): Promise<User | undefined> {
  const response = await api.get(`/users/${id}`);
  return response.ok ? response.json() : undefined;
}

// Avoid
function fetchUser(id) {
  return api.get(`/users/${id}`).then((r) => r.json());
}
```

## React (when applicable)

- Functional components with TypeScript
- Type props with interfaces
- Use React.FC sparingly (or not at all)
- Prefer named exports

```typescript
interface ButtonProps {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
}

export function Button({ label, onClick, variant = "primary" }: ButtonProps) {
  return (
    <button className={`btn-${variant}`} onClick={onClick}>
      {label}
    </button>
  );
}
```

## Error Handling

- Create typed error classes
- Use discriminated unions for result types
- Handle promise rejections explicitly

```typescript
// Result type pattern
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

async function parseConfig(path: string): Promise<Result<Config, ParseError>> {
  try {
    const data = await fs.readFile(path, "utf-8");
    return { ok: true, value: JSON.parse(data) };
  } catch (e) {
    return { ok: false, error: new ParseError(`Invalid config: ${path}`) };
  }
}
```

## Imports

- Use ES modules
- Prefer named imports over default imports
- Group and sort imports: external → internal → relative
- Use path aliases for deep imports

```typescript
// Good
import { useState, useEffect } from "react";
import { Button, Card } from "@/components";
import { formatDate } from "./utils";
```

## Async Patterns

- Always handle errors in async code
- Use Promise.all for parallel operations
- Avoid floating promises (always await or handle)

```typescript
// Good - parallel with error handling
const [users, posts] = await Promise.all([
  fetchUsers().catch(() => []),
  fetchPosts().catch(() => []),
]);

// Avoid - floating promise
fetchData(); // Missing await!
```

## Testing

- Use Jest or Vitest
- Type test utilities and mocks
- Use describe/it structure

```typescript
describe("UserService", () => {
  it("fetches user by id", async () => {
    const user = await service.getUser("123");
    expect(user?.email).toBe("test@example.com");
  });
});
```
