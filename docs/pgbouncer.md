# PostgreSQL transaction pooling

Keep DATABASE_URL pointed at PostgreSQL. Set DATABASE_POOL_URL to a transaction-mode PgBouncer endpoint with the same database and credentials. Set DATABASE_POOL_CA_CERT to the PEM CA certificate for that endpoint to verify its TLS identity independently of the direct database's configured trust.

Ordinary queries and transactions use the pooled endpoint. Session advisory locks and LISTEN subscriptions use separate direct connections. Schema initialization and dynamic migrations use a separate direct migration pool. pg-boss retains its existing direct endpoint, including its notification connection.

DATABASE_POOL_MAX bounds each process's shared query pool (default 10). DATABASE_DIRECT_POOL_MAX bounds its separate coordination session pool (default 32). Both accept integers from 1 to 100. DATABASE_SANDBOX_POOL_MAX independently bounds sandbox coordination connections (default 32, any positive safe integer). Sandbox providers, resource operations, and swarm reconciliation share this pool. Connections open on demand; increasing the limit permits more concurrent sandbox operations without increasing query or general coordination capacity. Apply size changes when starting a new process; existing pools do not resize in place.

Migrations use a shared one-connection pool. Count query, coordination, sandbox, and migration connections across every process, database and pooler replica when calculating database capacity, including overlapping processes during rollout. PgBouncer limits are per database/user and per pooler process; direct sandbox connections bypass those limits. Leave PostgreSQL headroom for other clients and maintenance. The pool split does not isolate database CPU or query load, and cron or loop lifecycle locks may still occupy coordination connections while their turns run.

Without DATABASE_POOL_URL, queries and sessions use separate pools to the direct database. Stores sharing a URL share the corresponding underlying pool, with reference-counted close. A closed store cannot reopen itself.

Use PgPool.pool() for ordinary transactions and PgPool.sessionPool() only when the PostgreSQL session must remain pinned, such as session locks and subscriptions. Sandbox advisory locks use PgPool.sessionPool("sandbox"), always through the direct database endpoint. Independent operations borrow separate connections; nested sandbox locks reuse their operation's connection until its last callback finishes. Failed lock queries discard that connection after outstanding callbacks finish, preserving operation and cleanup errors. Cancellation must finish the protected work before releasing its lock.

Register migrations through the helper; never run session-lock-based migrations through the transaction endpoint. Query-specific timeouts execute inside a transaction using SET LOCAL, preventing timeout state from leaking between PgBouncer borrowers.

Run scripts/test-pgbouncer.sh to create isolated PostgreSQL and TLS-enabled PgBouncer containers and exercise pooling, lock-held writes, timeout cleanup, migration ordering and shutdown races. The fixture uses a single backend connection to verify multiplexing and a single direct session slot to catch connection starvation. The PgBouncer compatibility workflow runs it on every pull request.

Before enabling pooling on a deployment, verify schema initialization, notifications, job scheduling, TLS failures, cross-database access denial and application reconnect behavior. Roll back routing by removing DATABASE_POOL_URL and restarting the application; database contents do not change.
