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
    const params = new URLSearchParams();
    params.append("client_id", WAHOO_CLIENT_ID);
    params.append("client_secret", WAHOO_CLIENT_SECRET);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", WAHOO_REFRESH_TOKEN);

    const response = await axios.post(
      "https://api.wahooligan.com/oauth/token",
      params,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
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

    const workouts = response.data.workouts || response.data;

    if (!workouts || workouts.length === 0) {
      console.log("No se encontraron entrenamientos en tu cuenta de Wahoo.");
      return;
    }

    console.log(`Se han encontrado ${workouts.length} entrenamientos en Wahoo.`);

    for (const workout of workouts) {
      const workoutId = workout.id.toString();

      // Extraer métricas probando la estructura de resumen de Wahoo v1
      const summary = workout.workout_summary || workout.summary || {};
      const rawDistance = summary.distance_accum || workout.distance_accum || 0; // en metros
      const rawDuration = summary.duration_active_accum || workout.duration_total || workout.moving_time_accum || 0; // en segundos

      // Conversiones de métricas
      const distanceInKilometers = parseFloat((rawDistance / 1000).toFixed(2));
      const elapsedTimeInHours = parseFloat((rawDuration / 3600).toFixed(2));
      
      const averageSpeedKmH = elapsedTimeInHours > 0 
        ? parseFloat((distanceInKilometers / elapsedTimeInHours).toFixed(2)) 
        : 0;

      const startDate = workout.starts_at || workout.created_at;
      const workoutName = workout.name || `Ciclismo Wahoo (${startDate ? startDate.split('T')[0] : 'Sin fecha'})`;

      // Intentar buscar en Notion tanto por 'Wahoo ID' como por 'Strava ID' (para mantener compatibilidad)
      let existingPage = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: {
          or: [
            { property: "Wahoo ID", rich_text: { equals: workoutId } },
            { property: "Strava ID", rich_text: { equals: workoutId } }
          ]
        },
      }).catch(async () => {
        // Fallback por si la base de datos de Notion solo tiene 'Strava ID' o solo 'Wahoo ID'
        return await notion.databases.query({
          database_id: NOTION_DATABASE_ID,
          filter: {
            property: "Wahoo ID",
            rich_text: { equals: workoutId }
          }
        }).catch(() => ({ results: [] }));
      });

      if (existingPage.results.length === 0) {
        // Intentar crear la página en Notion ajustando la columna de ID
        const properties = {
          Name: {
            title: [{ text: { content: workoutName } }],
          },
          Distance: {
            number: distanceInKilometers,
          },
          Date: {
            date: { start: startDate },
          },
          Elapsed: {
            number: elapsedTimeInHours,
          },
          Media: {
            number: averageSpeedKmH,
          },
        };

        // Asignamos 'Wahoo ID' (o 'Strava ID' si no has renombrado la columna en Notion)
        properties["Wahoo ID"] = {
          rich_text: [{ text: { content: workoutId } }],
        };

        try {
          await notion.pages.create({
            parent: { database_id: NOTION_DATABASE_ID },
            properties: properties,
          });
          console.log(`✅ Entrenamiento '${workoutName}' (${distanceInKilometers} km) añadido a Notion.`);
        } catch (notionError) {
          if (notionError.message.includes("Wahoo ID")) {
            // Si Notion falla porque la columna aún se llama 'Strava ID'
            delete properties["Wahoo ID"];
            properties["Strava ID"] = { rich_text: [{ text: { content: workoutId } }] };
            await notion.pages.create({
              parent: { database_id: NOTION_DATABASE_ID },
              properties: properties,
            });
            console.log(`✅ Entrenamiento '${workoutName}' añadido a Notion (usando 'Strava ID').`);
          } else {
            console.error(`❌ Error al guardar '${workoutName}' en Notion:`, notionError.message);
          }
        }
      } else {
        console.log(`ℹ️ El entrenamiento '${workoutName}' ya existía en Notion.`);
      }
    }
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log("El token de Wahoo expiró, renovando...");
      WAHOO_ACCESS_TOKEN = await refreshAccessToken();
      await getActivities();
    } else {
      console.error(`Error general al sincronizar: ${error.message}`);
    }
  }
}

// Ejecutar la sincronización
getActivities();
