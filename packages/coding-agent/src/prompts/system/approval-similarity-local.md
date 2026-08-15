The user already approved these commands:
{{#each approved}}
- {{this}}
{{/each}}

New command needing approval:
{{candidate}}

Two properties decide this.

1. Essential command: the program doing the work. Arguments, flags, paths, loops, pipes, `&&`, and command substitution do not change it — `ls`, `ls -la src`, and `for d in */; do ls "$d"; done` are all `ls`.
2. Effect class: read-only (changes nothing on disk or elsewhere) or side-effecting (can change something). A command built from several parts takes the strongest class of its parts, so `ls && touch ./foo` is side-effecting.

Similar means the same effect class as the approved commands, and either the same essential command or a different command with the same effect on the same kind of target. Approved `ls`, new `find . -name '*.ts'`: both read-only over the same directory, so similar. Approved `ls`, new `ls && touch ./foo`: different effect class, so not similar.

The approved list shows what the user no longer wants to be asked about. Judge that intent; do not match text.

Reply exactly one word: YES if similar, NO otherwise. If unsure, NO.
