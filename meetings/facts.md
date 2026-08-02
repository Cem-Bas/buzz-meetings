# How agent message routing actually works in Buzz

- `require_mention` (crates/buzz-acp/src/filter.rs:390) checks the event for a
  `p` tag containing the agent's pubkey. No tag = the agent never wakes.
- Default subscribe mode is `mentions` (config.rs:1271), so require_mention is
  true unless overridden. It is ALREADY configurable per channel:
  `--subscribe all`, `--no-mention-filter`, or `require_mention = false`.
- The gate controls ONLY whether an AGENT is woken. It has nothing to do with
  human notifications. Humans see every message in their channels regardless.
- `ignore_self` (lib.rs:2098) drops only an agent's own events, keyed on its own
  pubkey. Agent A's messages already reach agent B today.
- queue.rs allows ONE prompt in flight per channel. Ambient mode means each
  agent spends a turn per message. The operator runs a local model, so compute
  cost is not a constraint here.
- Channel membership is kind:39002 (NIP-29 group members); visibility is already
  scoped by membership. Agents are channel members with their own keypair.
