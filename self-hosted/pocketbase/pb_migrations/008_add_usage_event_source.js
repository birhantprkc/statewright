/// <reference path="../pb_data/types.d.ts" />

// Persist the independent telemetry sequence channel on each durable event so
// stale reports can be rejected transactionally before projection or receipt.
migrate(function (app) {
  var events = app.findCollectionByNameOrId('workflow_usage_events')
  events.fields.add(new Field({
    name: 'source',
    type: 'text',
    required: false,
    max: 100,
  }))
  events.indexes.push('CREATE INDEX idx_usage_event_run_epoch_source_sequence ON workflow_usage_events (run_id, state_epoch, source, sequence)')
  app.save(events)
}, function (_app) {
  // Forward-only provenance field. Removing it would make retained per-source
  // sequence evidence ambiguous.
})
