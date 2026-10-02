// What the caller typed before the verb: `rev`, `gp-rev`, `helmo run`, or just
// `helmo` under one of the front command's verb groups.
export const commandName = process.env['REV_COMMAND_NAME']?.trim() || 'rev';

// The prefix that spells EVERY verb, which `commandName` does not: a verb
// group's name stands for one verb and spells only that one — `helmo release
// upgrade` is a command and `helmo status` is not. So a message naming a verb
// OTHER than the one the caller invoked is composed from here, where every verb
// is reachable. The front command sets it; under `rev`, `gp-rev` or `helmo run`
// it is the invoked name itself and every message reads as it always did.
export const runCommand = process.env['REV_RUN_COMMAND']?.trim() || commandName;
