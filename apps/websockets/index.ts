import { WebSocketServer } from "ws";
import { prisma } from "db/client"

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) {
    console.warn("SLACK_WEBHOOK_URL is not set in apps/websockets/.env — Slack notifications are off");
}

const COLUMN_LABELS: Record<string, string> = {
    backlog: "Backlog",
    todo: "To Do",
    inprogress: "In Progress",
    review: "Review",
    done: "Done",
};
const label = (key: string) => COLUMN_LABELS[key] ?? key;

// Slack mrkdwn treats &, < and > as markup; titles are user-typed, so escape them.
const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function notifySlack(text: string): Promise<void> {
    if (!SLACK_WEBHOOK_URL) return;
    const res = await fetch(SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
    });
    if (!res.ok) {
        const retryAfter = res.headers.get("retry-after");
        throw new Error(`slack webhook: HTTP ${res.status} ${await res.text()}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`);
    }
}

const server = new WebSocketServer({ port: Number(process.env.WS_PORT ?? 3002) });
const connections = [];
const ROOMS: any = {}


interface Issue {id: string, key: string, title: string, sectionId: string}

const ISSUES: Issue[] = []

// Human-readable card keys (TRL-1, TRL-2…). They are what a developer puts in a
// branch name, and what the GitHub webhook uses to find the card. In-memory for
// now, so the counter restarts with the server.
const KEY_PREFIX = "TRL";
let nextIssueNumber = 1;

// Sockets that have closed throw on send(); only talk to the open ones.
function broadcast(message: unknown) {
    const data = JSON.stringify(message);
    for (const s of connections) {
        if (s.readyState === s.OPEN) s.send(data);
    }
}

// The one place a card changes column: used by drag-and-drop over the socket
// and by the internal endpoint the backend calls for GitHub events.
function moveIssue(issue: Issue, to: string, reason?: string) {
    const from = issue.sectionId;
    issue.sectionId = to;
    broadcast({ type: "issue_moved", issue });
    const why = reason ? ` — ${escapeSlack(reason)}` : "";
    notifySlack(`${issue.key} · *${escapeSlack(issue.title)}* moved ${label(from)} → ${label(to)}${why}`)
        .catch((err) => console.error(err));
}

// --- Internal endpoint for the backend --------------------------------------
// The backend receives GitHub webhooks but the board lives here in memory, so
// it asks this server to move the card. Guarded by a shared token from .env.
const WS_INTERNAL_TOKEN = process.env.WS_INTERNAL_TOKEN;
if (!WS_INTERNAL_TOKEN) {
    console.warn("WS_INTERNAL_TOKEN is not set in apps/websockets/.env — GitHub-driven moves are off");
}

Bun.serve({
    port: Number(process.env.WS_INTERNAL_PORT ?? 3003),
    async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/internal/issue-moved") {
            return new Response("not found", { status: 404 });
        }
        if (!WS_INTERNAL_TOKEN) return new Response("WS_INTERNAL_TOKEN not configured", { status: 503 });
        if (req.headers.get("authorization") !== `Bearer ${WS_INTERNAL_TOKEN}`) {
            return new Response("unauthorized", { status: 401 });
        }
        const body = (await req.json()) as { key?: unknown; sectionId?: unknown; reason?: unknown };
        if (typeof body.key !== "string" || typeof body.sectionId !== "string" || !(body.sectionId in COLUMN_LABELS)) {
            return Response.json({ error: "expected { key: string, sectionId: <column key> }" }, { status: 400 });
        }
        const issue = ISSUES.find((i) => i.key === body.key);
        if (!issue) return Response.json({ error: `no card with key ${body.key}` }, { status: 404 });
        moveIssue(issue, body.sectionId, typeof body.reason === "string" ? body.reason : undefined);
        return Response.json({ ok: true, issue });
    },
});

//for random id --- in trello from headers we will extract who is this user (JWT), will not assign random userid then hit
//database, and from there extract user email and user profile and store in Rooms array

server.on( "connection", (socket, req) => {
    connections.push(socket);
    socket.on("message", (data) => {

        const parsedData = JSON.parse(data);

        if(parsedData.type === "join") {
            const boardId = parsedData.boardId;
            if(!ROOMS[boardId]) { //check if there is no user board will create empty one 
                ROOMS[boardId] = []; // this will create a new board in our memory
            }
            const newUserId = Math.random();  // generating random new user id

            for(let i = 0; i < ROOMS[boardId].length; i++){ // we are going to all users and let them know new user joined
                const user = ROOMS[boardId][i];
                user.socket.send(JSON.stringify({
                    type: "join",
                    userId: newUserId
                }))
            }
            ROOMS[boardId].push({ userId: newUserId, socket: socket}); // push to the global users array

            //telling new user as initial state, show all existing users as showing who are already connected - by showing their profiles
            socket.send(JSON.stringify({
                type: "initial_state",
                users: ROOMS[boardId].filter(x => x.userId != newUserId).map(u => ({id: u.userId})),
                issues: ISSUES,
            }))
        }
    })
    //to close or cancel a user from a board - first we need to find out which all boards that users was connected
    socket.on("close", () => {
        Object.entries(ROOMS).map(([roomID, users]) => {
            const userExists = users.find(u => u.socket == socket)
            if(userExists) {
                ROOMS[roomID] = ROOMS[roomID].filter(x => x.socket != socket);
                users.forEach(({socket}) => socket.send(JSON.stringify({
                    type: "leave",
                    userId: userExists.userId
                })))
            }
        })
    })

    socket.on("message", (data) => {
        const parsedData = JSON.parse(data.toString());
        if(parsedData.type == "issue_added") {
            const newIssue: Issue = {
                id: crypto.randomUUID(),
                key: `${KEY_PREFIX}-${nextIssueNumber++}`,
                title: parsedData.title,
                sectionId: parsedData.sectionId,
            }
            ISSUES.push(newIssue)
            broadcast({ type: "issue_added", issue: newIssue })
            notifySlack(`${newIssue.key} · New card in *${label(newIssue.sectionId)}*: ${escapeSlack(newIssue.title)}`)
                .catch((err) => console.error(err));
        }

        if (parsedData.type === "issue_moved") {
            const issue = ISSUES.find((i) => i.id === parsedData.issueId);
            if (!issue) return;
            moveIssue(issue, parsedData.sectionId);
        }

        if(parsedData.type == "issue_delete") {
            const issue = ISSUES.find((i) => i.id === parsedData.issueId);
            broadcast({ type: "issue_delete", issueId: parsedData.issueId });
        }
    })

})