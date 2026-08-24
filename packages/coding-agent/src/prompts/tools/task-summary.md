<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
{{#if artifact}}<artifact uri="{{artifact.uri}}" bytes="{{artifact.size}}" lines="{{artifact.lineCount}}" sha256="{{artifact.sha256}}" />{{/if}}
{{#if artifactError}}<artifact-unavailable>Full output was not persisted: {{artifactError}}. Read what is below; there is no file to open.</artifact-unavailable>{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `hub` to resume instead of redoing the work.{{/if}}</abort-reason>
{{/if}}
{{#if truncated}}
<preview{{#if artifact}} full-output="{{artifact.uri}}"{{/if}}>
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
</task-result>
