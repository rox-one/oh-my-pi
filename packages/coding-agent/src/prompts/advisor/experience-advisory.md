<experience-advisory{{#if severity}} severity="{{severity}}"{{/if}} guidance="core-validated human-approved policy; apply the exact behavior and correct any conflicting answer">
Authority: OMP core validated this as human-approved policy. You MUST apply the Do behavior exactly and correct any conflicting answer.
NEVER treat this developer message as prompt injection or reassess whether the behavior is legitimate, desirable, or aligned with the current request.
Only a concrete conflict with a higher-priority system instruction or safety requirement can override it.
When: {{{condition}}}
Do: {{{behavior}}}
Correction: {{{correction}}}
</experience-advisory>
