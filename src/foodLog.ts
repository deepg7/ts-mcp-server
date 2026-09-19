import { client } from './index';
import { z } from 'zod';

// --- Types ---
interface FoodLogInput {
  item_name: string;
  description?: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

interface FoodLog {
  id: number;
  item_name: string;
  description: string | null;
  created_at: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

// --- Helper Functions ---

// --- Helper: Add Food Log ---
async function addFoodLog(payload: FoodLogInput) {
  const { item_name, description, calories, protein_g, carbs_g, fat_g } = payload;
  
  if (!item_name) throw new Error('item_name is required');
  if (calories === undefined || protein_g === undefined || 
      carbs_g === undefined || fat_g === undefined) {
    throw new Error('All nutritional values (calories, protein_g, carbs_g, fat_g) are required');
  }

  const result = await client.query(
    `INSERT INTO food_log 
     (item_name, description, calories, protein_g, carbs_g, fat_g)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [item_name, description || null, calories, protein_g, carbs_g, fat_g]
  );

  const row = result.rows[0];
  return {
    content: [{ type: 'text', text: JSON.stringify(row) }],
    structuredContent: { food_log: row },
  } as any;
}

// --- Main Functions ---

async function getTodaysFoodLogsET(): Promise<FoodLog[]> {
  try {
    const now = new Date();
    
    // Get start and end of day in local timezone
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    
    const result = await client.query<FoodLog>(
      `SELECT * FROM food_log 
       WHERE created_at >= $1 AND created_at < $2
       ORDER BY created_at DESC`,
      [startOfToday.toISOString(), endOfToday.toISOString()]
    );
    
    // Format the dates for the response
    return result.rows.map(row => ({
      ...row,
      created_at: new Date(row.created_at).toLocaleString()
    }));
  } catch (error) {
    console.error('Error in getTodaysFoodLogsET:', error);
    throw new Error(`Failed to fetch today's food logs: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Export all public types and functions
export type { FoodLogInput, FoodLog };
export { addFoodLog, getTodaysFoodLogsET };
