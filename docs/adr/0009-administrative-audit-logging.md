# 0009: Administrative audit logging

## Decision

`administrative_audit_events` is append-oriented. Authenticated clients have SELECT only; triggers owned by the database append successful organization, membership, class, teacher association, and entitlement changes in the same transaction as each mutation. Rows include timestamp, actor ID, organization ID, action, target type/ID, result, and limited non-sensitive details. Tenant administrators read only their organization's events; platform operators read all events.

## Consequences

Rolled-back mutations leave no success event. The audit table does not contain student content, secrets, before/after payloads, or a full request log. Failed attempts need an external operational log if that becomes a requirement. Trusted database administrators can still maintain the table; retention and export policy are deferred.
