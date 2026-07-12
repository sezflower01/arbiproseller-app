-- Set statement timeout to 15 seconds to prevent queries from running forever
-- and creating zombie "idle in transaction" connections that block everything
ALTER ROLE authenticator SET statement_timeout = '15s';

-- Set idle-in-transaction timeout to kill zombie connections after 30 seconds
ALTER ROLE authenticator SET idle_in_transaction_session_timeout = '30s';