// The spaces the server runs (src/space.js, SPACES.md), by name: only these exist, so nobody can make new ones by
// typing addresses. Each is a module with:
//   areas: ["main", …]              its areas, one Durable Object each: /space/<name>/<area>
//   access?: "accounts" | "role:<app>/<role>"   who may enter (default: any active account)
//   maxPeople?: number              people per area at once (at most 30, the default)
//   version: number                 the saved world's format; raise it when that changes, with upgrade()
//   create(area) → world            a new area's world (JSON-able; kept small: at most 100 KB saved)
//   upgrade?(world, fromVersion, area) → world   a world saved by an older version, brought up to this one
//   wake?(world, awayMs, { now })   the area wakes: catch up on what happened while nobody was here
//   join?(world, person, { now }) → event?       a person arrives ({ id, name, avatar }; not again from another tab)
//   leave?(world, id, { now }) → event?          their last connection closed
//   input(world, id, msg, { now }) → event?      a message from them (any JSON object: check it, people can send
//                                   anything); the event (any small JSON object), if any, goes to everyone
//   view(world, id) → object        the whole area as a newcomer gets it
// Everything happens on people's messages: there's no clock running, so the area can sleep between them.
import probe from "./spaces/probe.js";

export const SPACES = { probe };
