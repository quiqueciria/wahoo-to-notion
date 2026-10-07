const axios = require("axios");
const { Client } = require("@notionhq/client");

// Configuración de Wahoo
let WAHOO_ACCESS_TOKEN = process.env.WAHOO_ACCESS_TOKEN;
const WAHOO_REFRESH_TOKEN = process.env.WAHOO_REFRESH_TOKEN;
const WAHOO_CLIENT_ID = process.env.WAHOO_CLIENT_ID;
const WAHOO_CLIENT_SECRET = process.env.WAHOO_CLIENT_SECRET;
const wahooUrl = "https://api.wahooligan.com/v1/workouts";

// Configuración de Notion
const notion = new Client({ auth: process.env.NOTION_INTEGRATION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Función para actualizar el token de Wahoo
async function refreshAccessToken() {
  try {
    const response = await axios.post(
      "https://api.wahooligan.com/oauth/token",
      null,
      {
        params: {
          client_id: WAHOO_CLIENT_ID,
          client_secret: WAHOO_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: WAHOO_REFRESH_TOKEN,
        },
      }
    );

    WAHOO_ACCESS_TOKEN = response.data.access_token;
    console.log("Nuevo token de acceso de Wahoo obtenido con éxito.");
    return WAHOO_ACCESS_TOKEN;
  } catch (error) {
    console.error("Error al renovar el token de acceso de Wahoo:", error.response?.data || error);
    throw error;
  }
}

// Función para obtener entrenamientos de Wahoo y sincronizar con Notion
async function getActivities() {
  try {
    const response = await axios.get(wahooUrl, {
      headers: { Authorization: `Bearer ${WAHOO_ACCESS_TOKEN}` },
    });

    // Wahoo devuelve la lista dentro del campo `workouts`
    const workouts = response.data.workouts || response.data;

    for (const workout of workouts) {
      const workoutId = workout.id.toString();
      const rawDistance = workout.distance_accum || (workout.summary && workout.summary.distance_accum) || 0;
      const rawDuration = workout.duration_total || workout.moving_time_accum || 0;

      // Conversiones de métricas
      const distanceInKilometers = parseFloat((rawDistance / 1000).toFixed(2));
      const elapsedTimeInHours = parseFloat((rawDuration / 3600).toFixed(2));
      
      // Cálculo de velocidad media en km/h
      const averageSpeedKmH = elapsedTimeInHours > 0 
        ? parseFloat((distanceInKilometers / elapsedTimeInHours).toFixed(2)) 
        : 0;

      const workoutName = workout.name || workout.title || `Entrenamiento Wahoo (${workout.starts_at?.split('T')[0]})`;

      // Buscar si el entrenamiento ya existe en Notion usando el ID
      const existingPage = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: {
          property: "Strava ID", // Puedes renombrar esta propiedad a "Wahoo ID" en Notion si lo deseas
          rich_text: {
            equals: workoutId,
          },
        },
      });

      if (existingPage.results.length === 0) {
        // Crear nueva página en Notion
        await notion.pages.create({
          parent: { database_id: NOTION_DATABASE_ID },
          properties: {
            Name: {
              title: [
                {
                  text: {
                    content: workoutName,
                  },
                },
              ],
            },
            Distance: {
              number: distanceInKilometers,
            },
            Date: {
              date: {
                start: workout.starts_at,
              },
            },
            Elapsed: {
              number: elapsedTimeInHours,
            },
            Media: {
              number: averageSpeedKmH,
            },
            "Strava ID": {
              rich_text: [
                {
                  text: {
                    content: workoutId,
                  },
                },
              ],
            },
          },
        });
        console.log(`Entrenamiento '${workoutName}' añadido a Notion.`);
      } else {
        console.log(`Entrenamiento '${workoutName}' ya existe en Notion.`);
      }
    }
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log("El token de Wahoo expiró, renovando...");
      WAHOO_ACCESS_TOKEN = await refreshAccessToken();
      // Reintentar con el nuevo token
      await getActivities();
    } else {
      console.error(`Error al obtener entrenamientos de Wahoo: ${error.message}`);
    }
  }
}

// Ejecutar sincronización
getActivities();
