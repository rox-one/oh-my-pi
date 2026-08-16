Approved commands, one JSON string per `- ` list item, between the markers:
{{fence}}
{{#each approved}}
- {{this}}
{{/each}}
{{fence}}

New command, one JSON string, between the same markers:
{{fence}}
{{candidate}}
{{fence}}
