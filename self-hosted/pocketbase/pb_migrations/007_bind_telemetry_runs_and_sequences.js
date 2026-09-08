/// <reference path="../pb_data/types.d.ts" />

// Bind telemetry projections to the API-key tenant that created them and keep
// independent monotonic cursors for each native telemetry source.
migrate(function (app) {
  var runs = app.findCollectionByNameOrId('workflow_runs')
  runs.fields.add(new Field({
    name: 'api_key_fingerprint',
    type: 'text',
    required: false,
    max: 128,
  }))
  runs.fields.add(new Field({
    name: 'telemetry_ownership_status',
    type: 'select',
    required: false,
    maxSelect: 1,
    values: ['unbound', 'bound', 'ambiguous'],
  }))
  runs.indexes = (runs.indexes || []).filter(function (index) {
    return index.indexOf('idx_runs_external_run_id') === -1
  })
  runs.indexes.push("CREATE UNIQUE INDEX idx_runs_external_owner ON workflow_runs (external_run_id, api_key_fingerprint) WHERE external_run_id IS NOT NULL AND external_run_id <> '' AND api_key_fingerprint IS NOT NULL AND api_key_fingerprint <> ''")
  runs.indexes.push('CREATE INDEX idx_runs_session_owner ON workflow_runs (session_id, api_key_fingerprint)')
  app.save(runs)

  var states = app.findCollectionByNameOrId('workflow_state_usage')
  states.fields.add(new Field({
    name: 'sequence_cursors',
    type: 'json',
    required: false,
    maxSize: 8192,
  }))
  app.save(states)

  var events = app.findCollectionByNameOrId('workflow_usage_events')
  events.indexes = (events.indexes || []).filter(function (index) {
    return index.indexOf('idx_usage_event_id') === -1
  })
  events.indexes.push('CREATE UNIQUE INDEX idx_usage_event_owner ON workflow_usage_events (api_key_fingerprint, event_id)')
  app.save(events)

  // Existing usage records already carry the key fingerprint. Bind runs when
  // that evidence is unambiguous; explicitly quarantine mixed-owner history
  // rather than guessing or silently creating a shadow run.
  var runRecords = app.findRecordsByFilter('workflow_runs', '1=1', '', 0, 0)
  for (var i = 0; i < runRecords.length; i++) {
    var run = runRecords[i]
    var fingerprints = {}
    var usageEvents = app.findRecordsByFilter('workflow_usage_events', 'run_id = {:run}', '', 0, 0, { run: run.id })
    var stateUsage = app.findRecordsByFilter('workflow_state_usage', 'run_id = {:run}', '', 0, 0, { run: run.id })
    var evidence = usageEvents.concat(stateUsage)
    for (var j = 0; j < evidence.length; j++) {
      var fingerprint = evidence[j].get('api_key_fingerprint')
      if (fingerprint) fingerprints[fingerprint] = true
    }
    var owners = Object.keys(fingerprints)
    if (owners.length === 1) {
      run.set('api_key_fingerprint', owners[0])
      run.set('telemetry_ownership_status', 'bound')
    } else if (owners.length > 1) {
      run.set('api_key_fingerprint', '')
      run.set('telemetry_ownership_status', 'ambiguous')
    } else {
      run.set('telemetry_ownership_status', 'unbound')
    }
    app.save(run)
  }
}, function (_app) {
  // Forward-only evidence ownership. Rollback retains the tenant binding and
  // monotonic cursors rather than making old telemetry ambiguous again.
})
