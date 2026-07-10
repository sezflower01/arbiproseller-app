# Visual Basic .NET - Supabase FNSKU Integration

## Overview

This Visual Basic .NET implementation retrieves FNSKU (X00 codes) from your Lovable Supabase backend, exactly like the web app does. Instead of calling Amazon SP-API directly, it calls your Supabase edge functions.

## Architecture

```
VB.NET App → Supabase Edge Function (get-fnsku) → fnsku_map table OR Amazon SP-API → Return FNSKU
```

**Benefits:**
- ✅ No need to implement AWS SigV4 signing in VB.NET
- ✅ Leverages existing backend infrastructure
- ✅ Uses cached FNSKU mappings from fnsku_map table
- ✅ User authentication handled by Supabase JWT tokens
- ✅ Same data source as web app (consistency)

## Files Provided

1. **VB_Supabase_FNSKU.vb** - Complete VB.NET client for Supabase FNSKU retrieval
2. **VB_SUPABASE_README.md** - This setup guide

## Prerequisites

1. **Visual Studio** (2019 or later recommended)
2. **NuGet Packages:**
   - `System.Text.Json` (JSON parsing)
   - `BarcodeLib` (barcode generation)
3. **Supabase Account** with seller authorization connected
4. **User Authentication** - JWT access token from Supabase auth

## Setup Instructions

### Step 1: Install NuGet Packages

Open Package Manager Console in Visual Studio:

```powershell
Install-Package System.Text.Json
Install-Package BarcodeLib
```

### Step 2: Add the Code to Your Project

1. Right-click your VB.NET project → **Add** → **Existing Item**
2. Select `VB_Supabase_FNSKU.vb`
3. The file will be added to your project

### Step 3: Configure Supabase Credentials

In your VB.NET form or startup code, initialize the client:

```vb
' Your Supabase project details
Dim supabaseUrl = "https://mstibdszibcheodvnprm.supabase.co"
Dim supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc"

' Get user's JWT token from your Supabase authentication flow
Dim userAccessToken = "YOUR_USER_JWT_TOKEN_HERE"

' Create client
Dim fnskuClient = New SupabaseFNSKUClient(supabaseUrl, supabaseAnonKey, userAccessToken)
```

### Step 4: Get User Authentication Token

**CRITICAL:** You need a valid Supabase JWT access token for the authenticated user.

#### Option A: Manual Login (for testing)

Call Supabase Auth REST API to login and get token:

```vb
Public Async Function LoginSupabaseAsync(email As String, password As String) As Task(Of String)
    Dim loginUrl = "https://mstibdszibcheodvnprm.supabase.co/auth/v1/token?grant_type=password"
    
    Dim requestBody = New With {
        .email = email,
        .password = password
    }
    Dim jsonBody = JsonSerializer.Serialize(requestBody)
    
    Dim request = New HttpRequestMessage(HttpMethod.Post, loginUrl)
    request.Headers.TryAddWithoutValidation("apikey", "YOUR_SUPABASE_ANON_KEY")
    request.Content = New StringContent(jsonBody, Encoding.UTF8, "application/json")
    
    Dim httpClient = New HttpClient()
    Dim response = Await httpClient.SendAsync(request)
    Dim responseBody = Await response.Content.ReadAsStringAsync()
    
    If Not response.IsSuccessStatusCode Then
        Throw New Exception($"Login failed: {responseBody}")
    End If
    
    Dim result = JsonDocument.Parse(responseBody)
    Dim accessToken = result.RootElement.GetProperty("access_token").GetString()
    
    Return accessToken
End Function
```

#### Option B: Use Supabase Auth Libraries

Consider using `supabase-csharp` NuGet package for full auth support:

```powershell
Install-Package supabase-csharp
```

## Usage Examples

### Example 1: Get FNSKU and Display Label

```vb
Private Async Sub btnGetLabel_Click(sender As Object, e As EventArgs)
    Try
        Dim asin = "B08L5VFJ2G"
        Dim title = "Sample Product Title"
        
        ' Get FNSKU via Supabase edge function
        Dim fnskuData = Await fnskuClient.GetFNSKUForASINAsync(asin)
        
        Console.WriteLine($"FNSKU: {fnskuData.fnsku}")
        Console.WriteLine($"Condition: {fnskuData.condition}")
        Console.WriteLine($"Source: {fnskuData.source}") ' "cache" or "api"
        
        ' Generate label image
        Dim labelImage = fnskuClient.GenerateLabelImage(
            asin,
            fnskuData.fnsku,
            fnskuData.condition,
            title
        )
        
        ' Display in PictureBox
        PictureBox1.Image = labelImage
        PictureBox1.SizeMode = PictureBoxSizeMode.Zoom
        
    Catch ex As Exception
        MessageBox.Show($"Error: {ex.Message}", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error)
    End Try
End Sub
```

### Example 2: Complete Workflow (All-in-One)

```vb
Private Async Sub btnPrintLabel_Click(sender As Object, e As EventArgs)
    Try
        Dim asin = txtASIN.Text.Trim()
        Dim title = txtTitle.Text.Trim()
        
        ' This does everything: fetch FNSKU, generate label, display in PictureBox
        Await fnskuClient.GetAndPrintLabelAsync(PictureBox1, asin, title)
        
        MessageBox.Show("Label ready to print!", "Success", MessageBoxButtons.OK, MessageBoxIcon.Information)
        
    Catch ex As Exception
        MessageBox.Show($"Error: {ex.Message}", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error)
    End Try
End Sub
```

### Example 3: Check Cache Only (No API Call)

```vb
Private Async Sub btnCheckCache_Click(sender As Object, e As EventArgs)
    Try
        Dim asin = "B08L5VFJ2G"
        Dim sellerId = "YOUR_SELLER_ID"
        Dim marketplaceId = "ATVPDKIKX0DER"
        
        ' Query fnsku_map table directly without triggering SP-API call
        Dim cached = Await fnskuClient.GetFNSKUFromCacheAsync(asin, sellerId, marketplaceId)
        
        If cached Is Nothing Then
            MessageBox.Show("No cached FNSKU found", "Cache Miss", MessageBoxButtons.OK, MessageBoxIcon.Information)
        Else
            MessageBox.Show($"Cached FNSKU: {cached.fnsku}", "Cache Hit", MessageBoxButtons.OK, MessageBoxIcon.Information)
        End If
        
    Catch ex As Exception
        MessageBox.Show($"Error: {ex.Message}", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error)
    End Try
End Sub
```

### Example 4: Sync All FNSKUs from Amazon Inventory

```vb
Private Async Sub btnSyncInventory_Click(sender As Object, e As EventArgs)
    Try
        lblStatus.Text = "Syncing inventory from Amazon..."
        btnSyncInventory.Enabled = False
        
        ' Call sync-fnsku-report edge function
        Dim processed = Await fnskuClient.SyncAllFNSKUAsync(Nothing)
        
        lblStatus.Text = $"Synced {processed} FNSKU mappings successfully!"
        lblStatus.ForeColor = Color.Green
        
        MessageBox.Show($"Successfully synced {processed} products from Amazon inventory", "Sync Complete", MessageBoxButtons.OK, MessageBoxIcon.Information)
        
    Catch ex As Exception
        lblStatus.Text = $"Sync failed: {ex.Message}"
        lblStatus.ForeColor = Color.Red
        MessageBox.Show($"Sync error: {ex.Message}", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error)
    Finally
        btnSyncInventory.Enabled = True
    End Try
End Sub
```

## Complete Windows Form Example

See the `FNSKULabelForm` class in `VB_Supabase_FNSKU.vb` for a complete working example with:
- ASIN input field
- Title input field
- "Get FNSKU & Generate Label" button
- Status label showing progress
- PictureBox for label preview

To use it:

```vb
' In your startup code or button click
Dim form = New FNSKULabelForm()
form.ShowDialog()
```

## How It Works

### 1. GetFNSKUForASINAsync Flow

```
VB.NET → POST /functions/v1/get-fnsku
      → Body: { "asin": "B08L5VFJ2G" }
      → Headers: Authorization: Bearer {JWT}, apikey: {ANON_KEY}
      ↓
Supabase Edge Function (get-fnsku)
      → Check fnsku_map table for cached mapping
      → If found: return cached FNSKU
      → If not found: call Amazon FBA Inventory API
      → Store result in fnsku_map
      ↓
VB.NET ← Response: { "fnsku": "X002ABC123", "condition": "NEW", "source": "cache" }
```

### 2. GetFNSKUFromCacheAsync Flow

```
VB.NET → GET /rest/v1/fnsku_map?asin=eq.B08L5VFJ2G&seller_id=eq.XXX&marketplace_id=eq.YYY
      → Headers: Authorization: Bearer {JWT}, apikey: {ANON_KEY}
      ↓
Supabase REST API
      → Query fnsku_map table directly
      → Return matching row(s)
      ↓
VB.NET ← Response: [{ "fnsku": "X002ABC123", "condition": "NEW", "seller_sku": "MY-SKU-001" }]
```

### 3. SyncAllFNSKUAsync Flow

```
VB.NET → POST /functions/v1/sync-fnsku-report
      → Body: {}
      → Headers: Authorization: Bearer {JWT}, apikey: {ANON_KEY}
      ↓
Supabase Edge Function (sync-fnsku-report)
      → Create FBA inventory report via Amazon SP-API
      → Poll until report is ready
      → Download and parse report (CSV/TSV)
      → Batch upsert all FNSKU mappings into fnsku_map table
      ↓
VB.NET ← Response: { "processed": 2463, "status": "completed" }
```

## Authentication Details

### JWT Token Structure

The `userAccessToken` is a JWT (JSON Web Token) with this structure:

```json
{
  "sub": "user-uuid-here",
  "email": "user@example.com",
  "role": "authenticated",
  "iat": 1234567890,
  "exp": 1234567890
}
```

**Important:** JWT tokens expire after 1 hour by default. You'll need to:
1. Check token expiration before making calls
2. Refresh the token using Supabase refresh token flow
3. Store and reuse tokens securely

### Security Best Practices

1. **Never hardcode tokens** - Store in secure credential manager or config
2. **Use HTTPS only** - All Supabase calls are over HTTPS
3. **Handle token expiration** - Implement refresh token logic
4. **Validate responses** - Always check HTTP status codes

## Troubleshooting

### Error: "Invalid JWT"

**Cause:** Token expired or invalid

**Solution:** 
- Check token expiration timestamp
- Re-authenticate user to get fresh token
- Ensure token is properly formatted in Authorization header

### Error: "No FNSKU found"

**Cause:** ASIN not in inventory or not synced yet

**Solution:**
1. Run `SyncAllFNSKUAsync()` to sync inventory first
2. Verify seller authorization is connected in web app
3. Check that ASIN exists in your Amazon inventory

### Error: "CORS policy"

**Cause:** VB.NET desktop apps don't have CORS issues, but if using WebView control this can happen

**Solution:**
- Desktop apps bypass CORS
- If using WebView, this is expected - use direct HTTP calls instead

### Error: "Function timeout"

**Cause:** Large inventory sync taking too long

**Solution:**
- The sync function has 5-minute timeout
- For inventories >5000 products, may need to run multiple times
- Check edge function logs in Supabase dashboard

## API Reference

### SupabaseFNSKUClient Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `GetFNSKUForASINAsync` | `asin: String` | `Task(Of FNSKUResponse)` | Get FNSKU for an ASIN (checks cache, then API) |
| `GetFNSKUFromCacheAsync` | `asin: String, sellerId: String, marketplaceId: String` | `Task(Of FNSKUResponse)` | Query cache only (no API call) |
| `SyncAllFNSKUAsync` | `progressCallback: Action(Of String, String, String)` | `Task(Of Integer)` | Sync all inventory FNSKUs |
| `GenerateLabelImage` | `asin: String, fnsku: String, condition: String, title: String` | `Bitmap` | Generate 3.5"x2" thermal label |
| `GetAndPrintLabelAsync` | `pictureBox: PictureBox, asin: String, title: String` | `Task` | Complete workflow: fetch + generate + display |

### FNSKUResponse Object

```vb
Public Class FNSKUResponse
    Public Property fnsku As String          ' X002ABC123
    Public Property condition As String      ' NEW, USED - LIKE NEW, etc.
    Public Property sellerSku As String      ' MY-SKU-001
    Public Property source As String         ' "cache" or "api"
End Class
```

## Comparison: Direct SP-API vs Supabase Approach

| Feature | Direct SP-API (AmazonFNSKU_VB.vb) | Supabase Approach (VB_Supabase_FNSKU.vb) |
|---------|-----------------------------------|------------------------------------------|
| **Complexity** | High (AWS SigV4, token refresh, report parsing) | Low (simple HTTP calls) |
| **Credentials Needed** | AWS keys, LWA client ID/secret, refresh token | Supabase URL + user JWT only |
| **Caching** | Must implement yourself | Built-in via fnsku_map table |
| **Consistency** | Separate from web app | Same data as web app |
| **Maintenance** | Must update if Amazon changes API | Backend handles changes |
| **Rate Limits** | Must handle yourself | Backend handles with retries |
| **Best For** | Offline use, full control | Online use, simplicity |

## Deployment Checklist

- [ ] Install required NuGet packages (System.Text.Json, BarcodeLib)
- [ ] Add `VB_Supabase_FNSKU.vb` to your VB.NET project
- [ ] Implement user authentication to get JWT token
- [ ] Configure Supabase URL and anon key
- [ ] Test with sample ASIN to verify connection
- [ ] Run initial FNSKU sync via `SyncAllFNSKUAsync()`
- [ ] Implement label printing workflow in your forms
- [ ] Handle token refresh for long-running apps

## Support

- **Web App:** https://arbiproseller.com/
- **Supabase Dashboard:** https://supabase.com/dashboard/project/mstibdszibcheodvnprm
- **Edge Functions Logs:** Check Supabase dashboard for debugging

## License

Same license as your Lovable/Supabase project.
