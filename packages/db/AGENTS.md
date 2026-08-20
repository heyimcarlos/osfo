# Database schema

`packages/db` owns PostgreSQL schema, migrations, Drizzle construction, and
database test support. Product queries and typed application failures belong to
their owning feature in `apps/worker`.

- Define new Drizzle field keys in `snake_case` so TypeScript property names and
  SQL column names match. Omit the column-name string when Drizzle can infer it.

  ```ts
  const table = pgTable("registration_invitations", {
    invitation_id: text().primaryKey(),
    created_at: timestamp({ withTimezone: true }).notNull(),
  });
  ```

- Specify a column-name string only when the SQL name must differ from the
  TypeScript key.
- Better Auth schema property keys are an adapter contract: keep its generated
  logical keys unless the auth configuration maps every renamed field. Its SQL
  column names remain `snake_case`.
- Preserve database constraints in the schema and migrations. Test constraints
  and transaction behavior against the real database fixture.
