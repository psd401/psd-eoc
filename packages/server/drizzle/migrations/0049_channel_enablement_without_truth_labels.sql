-- Lets a channel be enabled without a 'live-verified' truth label.
--
-- The label is hand-maintained state with no automated source: the rows are
-- written by db/seed.ts, and the only thing that could change one was a
-- verify-email-integration capability that exists for email and for no other
-- channel. On 2026-09-08 the aws-eum-sms label still read 'blocked' with
-- reason CARRIER_REGISTRATION_PENDING, six hours after the carrier approved
-- the registration, and nothing in the product could correct it.
--
-- This constraint was the last enforcement of that: it refused to enable any
-- channel whose label said 'blocked', so a drill delivered push and email
-- while SMS was never queued and nothing recorded why. The send paths no
-- longer consult the label either; enablement is the switch.
ALTER TABLE "channel_configurations"
  DROP CONSTRAINT "channel_configurations_blocked_disabled";
