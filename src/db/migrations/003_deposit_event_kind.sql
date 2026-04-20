-- Discriminate HubDepositor.Deposited vs PayoutReleased rows in deposit_event.
-- Values: 'DEPOSIT' | 'PAYOUT'. Default keeps pre-existing rows interpretable.

ALTER TABLE deposit_event
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'DEPOSIT';

CREATE INDEX IF NOT EXISTS idx_deposit_event_user_kind
    ON deposit_event (user_address, kind);
