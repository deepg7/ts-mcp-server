import 'dotenv/config';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { Client } from 'pg';
import { z } from 'zod';
import { oauthRouter, requireBearer } from './oauth';

// --- PostgreSQL Setup ---
export const client = new Client({
  user: process.env.PGUSER || 'deepgandhi',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'mcp_db',
  password: process.env.PGPASSWORD || 'mcp',
  port: Number(process.env.PGPORT) || 5432,
});

client.connect()
  .then(() => console.error('Connected to PostgreSQL'))
  .catch((err) => console.error('Postgres connection error:', err));

// --- Helpers: Get Calendar Events ---
async function getCalendarEvents(date?: string): Promise<any> {
  if (!date) throw new Error("params.date required (e.g. '2025-10-31')");

  const parsed = new Date(date);
  if (isNaN(parsed.getTime())) throw new Error('invalid date format');

  const startOfDay = new Date(parsed);
  startOfDay.setHours(0, 0, 0, 0);
  const nextDay = new Date(startOfDay);
  nextDay.setDate(nextDay.getDate() + 1);

  const result = await client.query(
    `SELECT id, title, start_time, end_time, description
     FROM events
     WHERE start_time >= $1 AND start_time < $2
     ORDER BY start_time`,
    [startOfDay.toISOString(), nextDay.toISOString()]
  );

  return {
    content: [{ type: 'text', text: JSON.stringify({ events: result.rows }) }],
    structuredContent: { events: result.rows },
  } as any;
}

// --- Helper: Create Event ---
async function createCalendarEvent(payload: {
  title: string;
  start_time: string;
  end_time?: string;
  description?: string;
}) {
  const { title, start_time, end_time, description } = payload;
  if (!title || !start_time) throw new Error('title and start_time are required');

  const start = new Date(start_time);
  if (isNaN(start.getTime())) throw new Error('invalid start_time');

  let endIso: string | null = null;
  if (end_time) {
    const end = new Date(end_time);
    if (isNaN(end.getTime())) throw new Error('invalid end_time');
    endIso = end.toISOString();
  }

  const result = await client.query(
    `INSERT INTO events (title, start_time, end_time, description)
     VALUES ($1, $2, $3, $4)
     RETURNING id, title, start_time, end_time, description`,
    [title, start.toISOString(), endIso, description || null]
  );

  const row = result.rows[0];
  return {
    content: [{ type: 'text', text: JSON.stringify(row) }],
    structuredContent: { event: row },
  } as any;
}

// --- MCP Server factory (one instance per connection) ---
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'demo-server',
    version: '1.0.0',
  });

  // Register add_food_log tool
  server.registerTool(
    'add_food_log',
    {
      title: 'Add Food Log',
      description: 'Add a new food log entry with nutritional information',
      inputSchema: {
        item_name: z.string(),
        description: z.string().optional(),
        calories: z.number(),
        protein_g: z.number(),
        carbs_g: z.number(),
        fat_g: z.number(),
      },
      outputSchema: { food_log: z.any() },
    },
    async (input: FoodLogInput) => addFoodLog(input)
  );

  // Register get_todays_food_logs tool
  server.registerTool(
    'get_todays_food_logs',
    {
      title: 'Get Today\'s Food Logs',
      description: 'Retrieve all food logs for the current day in ET timezone',
      inputSchema: {},
      outputSchema: {
        logs:z.any(),
        totals:z.any(),
      },
    },
    async () => {
      const logs = await getTodaysFoodLogsET();
      const totals = logs.reduce((acc, log) => ({
        calories: acc.calories + (log.calories || 0),
        protein_g: acc.protein_g + (log.protein_g || 0),
        carbs_g: acc.carbs_g + (log.carbs_g || 0),
        fat_g: acc.fat_g + (log.fat_g || 0),
      }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });

      return {
        content: [{ type: 'text', text: JSON.stringify({ logs, ...totals }) }],
        structuredContent: { logs, ...totals },
      };
    }
  );

  // 1) get_calendar_events tool
  server.registerTool(
    'get_calendar_events',
    {
      title: 'Get Calendar Events',
      description: 'Return events for a given date (YYYY-MM-DD)',
      inputSchema: { date: z.string() },
      outputSchema: { events: z.array(z.any()) },
    },
    async ({ date }: { date: string }) => getCalendarEvents(date)
  );

  // 3) add_event tool
  server.registerTool(
    'add_event',
    {
      title: 'Add Calendar Event',
      description: 'Create a new calendar event',
      inputSchema: {
        title: z.string(),
        start_time: z.string(),
        end_time: z.string().optional(),
        description: z.string().optional(),
      },
      outputSchema: { event: z.any() },
    },
    async (input: any) => createCalendarEvent(input)
  );

  // --- Greeting Resource (example) ---
  server.registerResource(
    'greeting',
    new ResourceTemplate('greeting://{name}', { list: undefined }),
    {
      title: 'Greeting Resource',
      description: 'Dynamic greeting generator',
    },
    async (uri: URL, { name }: any) => ({
      contents: [
        {
          uri: uri.href,
          text: `Hello, ${name}!`,
        },
      ],
    })
  );

  return server;
}

// Import food log functions
import { addFoodLog, getTodaysFoodLogsET, type FoodLog, type FoodLogInput } from './foodLog';

// --- Transport ---
// Default: streamable HTTP. The 401 + WWW-Authenticate challenge returned by
// requireBearer is what makes Claude Desktop open the Google auth popup.
// Set MCP_TRANSPORT=stdio for the classic stdio transport (no OAuth possible there:
// WWW-Authenticate is an HTTP mechanism, so stdio clients cannot auto-open a popup).
async function main() {
  if (process.env.MCP_TRANSPORT === 'stdio') {
    const server = createMcpServer();
    await server.connect(new StdioServerTransport());
    console.error('MCP server connected (stdio transport)');
    return;
  }

  const app = express();
  app.set('trust proxy', true); // honour ngrok's x-forwarded-proto/host
  app.use(express.json({ limit: '4mb' }));
  app.use(oauthRouter());

  app.post('/mcp', requireBearer, async (req, res) => {
    // Stateless mode: fresh server + transport per request.
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', requireBearer, (_req, res) => res.sendStatus(405));
  app.delete('/mcp', requireBearer, (_req, res) => res.sendStatus(405));

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.error(`MCP server (streamable HTTP) listening on http://localhost:${port}/mcp`);
    console.error(`For Claude Desktop: expose via HTTPS (e.g. "ngrok http ${port}") and add https://<host>/mcp as a custom connector`);
  });
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});

export {};
