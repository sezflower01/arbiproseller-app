
export interface GeoInfo {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
}

export async function fetchGeoInfo(): Promise<GeoInfo> {
  try {
    console.log("=== GEO INFO FETCH STARTED ===");
    console.log("Fetching geo information from ipapi.co...");
    
    const response = await fetch("https://ipapi.co/json/");
    
    if (!response.ok) {
      console.error("❌ Geo lookup failed with status:", response.status);
      console.error("Response details:", {
        status: response.status,
        statusText: response.statusText,
        url: response.url
      });
      throw new Error(`Geo lookup failed with status: ${response.status}`);
    }
    
    const data = await response.json();
    console.log("✅ Raw geo data received:", data);

    // Check if we got an error response from the API
    if (data.error) {
      console.error("❌ Geo API returned error:", data);
      throw new Error(`Geo API error: ${data.reason || 'Unknown error'}`);
    }

    const geoInfo = {
      ip: data.ip || null,
      country: data.country_name || null,
      region: data.region || null,
      city: data.city || null,
      latitude: typeof data.latitude === "number" ? data.latitude : parseFloat(data.latitude) || null,
      longitude: typeof data.longitude === "number" ? data.longitude : parseFloat(data.longitude) || null,
    };

    console.log("✅ Processed geo info:", geoInfo);
    console.log("=== GEO INFO FETCH COMPLETED ===");
    return geoInfo;
  } catch (error) {
    console.error("=== GEO INFO FETCH FAILED ===");
    console.error("❌ Error fetching geo info:", error);
    
    // Return empty geo data on error but log it clearly
    const fallbackGeo = {
      ip: null,
      country: null,
      region: null,
      city: null,
      latitude: null,
      longitude: null,
    };
    
    console.log("🔄 Using fallback geo data:", fallbackGeo);
    return fallbackGeo;
  }
}
