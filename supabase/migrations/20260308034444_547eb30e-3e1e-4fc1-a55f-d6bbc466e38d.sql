-- Indexes to prevent full-table scans that cause Disk IO exhaustion

CREATE INDEX IF NOT EXISTS idx_rcs_fetched_at 
ON repricer_competitor_snapshots(fetched_at);

CREATE INDEX IF NOT EXISTS idx_rpa_created_at_action 
ON repricer_price_actions(created_at, action_type);

CREATE INDEX IF NOT EXISTS idx_bb_alerts_dismissed_created 
ON bb_price_alerts(dismissed, created_at);

CREATE INDEX IF NOT EXISTS idx_seller_auth_user 
ON seller_authorizations(user_id);

CREATE INDEX IF NOT EXISTS idx_sales_sync_user 
ON sales_sync_state(user_id);

CREATE INDEX IF NOT EXISTS idx_roi_alerts_user_date 
ON roi_alerts(user_id, order_date);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_role 
ON user_roles(user_id, role);