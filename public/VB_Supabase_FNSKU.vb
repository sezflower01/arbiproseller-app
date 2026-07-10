Imports System.Net.Http
Imports System.Text
Imports System.Text.Json
Imports System.Threading.Tasks
Imports System.Collections.Generic
Imports System.Drawing
Imports System.Drawing.Imaging
Imports BarcodeLib ' Install-Package BarcodeLib via NuGet

''' <summary>
''' Supabase FNSKU Client for Visual Basic .NET
''' Retrieves FNSKU (X00 codes) via Lovable Supabase edge functions
''' </summary>
Public Class SupabaseFNSKUClient
    Private ReadOnly supabaseUrl As String
    Private ReadOnly supabaseAnonKey As String
    Private ReadOnly userAccessToken As String ' JWT token from Supabase auth
    Private ReadOnly httpClient As HttpClient

    ''' <summary>
    ''' Initialize the Supabase FNSKU client
    ''' </summary>
    ''' <param name="projectUrl">Your Supabase project URL (e.g., https://mstibdszibcheodvnprm.supabase.co)</param>
    ''' <param name="anonKey">Your Supabase anon/public key</param>
    ''' <param name="accessToken">User's JWT access token from Supabase authentication</param>
    Public Sub New(projectUrl As String, anonKey As String, accessToken As String)
        Me.supabaseUrl = projectUrl.TrimEnd("/"c)
        Me.supabaseAnonKey = anonKey
        Me.userAccessToken = accessToken
        Me.httpClient = New HttpClient()
    End Sub

    ''' <summary>
    ''' Data model for FNSKU response
    ''' </summary>
    Public Class FNSKUResponse
        Public Property fnsku As String
        Public Property condition As String
        Public Property sellerSku As String
        Public Property source As String ' "cache" or "api"
    End Class

    ''' <summary>
    ''' Data model for product info (optional, from Catalog API)
    ''' </summary>
    Public Class ProductInfo
        Public Property asin As String
        Public Property title As String
        Public Property imageUrl As String
        Public Property fnsku As String
        Public Property condition As String
    End Class

    ''' <summary>
    ''' Call Supabase edge function to get FNSKU for an ASIN
    ''' This replicates the web app's get-fnsku edge function call
    ''' </summary>
    Public Async Function GetFNSKUForASINAsync(asin As String) As Task(Of FNSKUResponse)
        Try
            ' Build the edge function URL
            Dim functionUrl = $"{supabaseUrl}/functions/v1/get-fnsku"
            
            ' Create request body
            Dim requestBody = New With {
                .asin = asin
            }
            Dim jsonBody = JsonSerializer.Serialize(requestBody)
            
            ' Create HTTP request
            Dim request = New HttpRequestMessage(HttpMethod.Post, functionUrl)
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {userAccessToken}")
            request.Headers.TryAddWithoutValidation("apikey", supabaseAnonKey)
            request.Content = New StringContent(jsonBody, Encoding.UTF8, "application/json")
            
            Console.WriteLine($"[GetFNSKU] Calling edge function for ASIN: {asin}")
            
            ' Send request
            Dim response = Await httpClient.SendAsync(request)
            Dim responseBody = Await response.Content.ReadAsStringAsync()
            
            If Not response.IsSuccessStatusCode Then
                Console.WriteLine($"[GetFNSKU] Error: {response.StatusCode} - {responseBody}")
                Throw New Exception($"Failed to get FNSKU: {response.StatusCode} - {responseBody}")
            End If
            
            Console.WriteLine($"[GetFNSKU] Success: {responseBody}")
            
            ' Parse response
            Dim result = JsonSerializer.Deserialize(Of FNSKUResponse)(responseBody)
            Return result
            
        Catch ex As Exception
            Console.WriteLine($"[GetFNSKU] Exception: {ex.Message}")
            Throw New Exception($"Error retrieving FNSKU for ASIN {asin}: {ex.Message}", ex)
        End Try
    End Function

    ''' <summary>
    ''' Query fnsku_map table directly via Supabase REST API
    ''' Useful for checking cache without triggering SP-API calls
    ''' </summary>
    Public Async Function GetFNSKUFromCacheAsync(asin As String, sellerId As String, marketplaceId As String) As Task(Of FNSKUResponse)
        Try
            ' Build REST API URL with filters
            Dim restUrl = $"{supabaseUrl}/rest/v1/fnsku_map?asin=eq.{Uri.EscapeDataString(asin)}&seller_id=eq.{Uri.EscapeDataString(sellerId)}&marketplace_id=eq.{Uri.EscapeDataString(marketplaceId)}&select=fnsku,condition,seller_sku"
            
            ' Create HTTP request
            Dim request = New HttpRequestMessage(HttpMethod.Get, restUrl)
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {userAccessToken}")
            request.Headers.TryAddWithoutValidation("apikey", supabaseAnonKey)
            request.Headers.TryAddWithoutValidation("Prefer", "return=representation")
            
            Console.WriteLine($"[GetCache] Querying fnsku_map for ASIN: {asin}")
            
            ' Send request
            Dim response = Await httpClient.SendAsync(request)
            Dim responseBody = Await response.Content.ReadAsStringAsync()
            
            If Not response.IsSuccessStatusCode Then
                Console.WriteLine($"[GetCache] Error: {response.StatusCode} - {responseBody}")
                Return Nothing
            End If
            
            ' Parse response (returns array)
            Dim results = JsonSerializer.Deserialize(Of List(Of Dictionary(Of String, Object)))(responseBody)
            
            If results Is Nothing OrElse results.Count = 0 Then
                Console.WriteLine($"[GetCache] No cache entry found for ASIN: {asin}")
                Return Nothing
            End If
            
            Dim record = results(0)
            Dim fnskuResponse = New FNSKUResponse With {
                .fnsku = If(record.ContainsKey("fnsku"), record("fnsku")?.ToString(), Nothing),
                .condition = If(record.ContainsKey("condition"), record("condition")?.ToString(), "NEW"),
                .sellerSku = If(record.ContainsKey("seller_sku"), record("seller_sku")?.ToString(), Nothing),
                .source = "cache"
            }
            
            Console.WriteLine($"[GetCache] Found FNSKU in cache: {fnskuResponse.fnsku}")
            Return fnskuResponse
            
        Catch ex As Exception
            Console.WriteLine($"[GetCache] Exception: {ex.Message}")
            Return Nothing
        End Try
    End Function

    ''' <summary>
    ''' Trigger FNSKU sync for all inventory via edge function
    ''' This calls the sync-fnsku-report function
    ''' </summary>
    Public Async Function SyncAllFNSKUAsync(progressCallback As Action(Of String, String, String)) As Task(Of Integer)
        Try
            ' Build the edge function URL
            Dim functionUrl = $"{supabaseUrl}/functions/v1/sync-fnsku-report"
            
            ' Create HTTP request (no body needed)
            Dim request = New HttpRequestMessage(HttpMethod.Post, functionUrl)
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {userAccessToken}")
            request.Headers.TryAddWithoutValidation("apikey", supabaseAnonKey)
            request.Content = New StringContent("{}", Encoding.UTF8, "application/json")
            
            Console.WriteLine($"[SyncFNSKU] Starting inventory sync...")
            
            ' Send request
            Dim response = Await httpClient.SendAsync(request)
            Dim responseBody = Await response.Content.ReadAsStringAsync()
            
            If Not response.IsSuccessStatusCode Then
                Console.WriteLine($"[SyncFNSKU] Error: {response.StatusCode} - {responseBody}")
                Throw New Exception($"Failed to sync FNSKU: {response.StatusCode} - {responseBody}")
            End If
            
            Console.WriteLine($"[SyncFNSKU] Response: {responseBody}")
            
            ' Parse response
            Dim result = JsonDocument.Parse(responseBody)
            Dim processed = result.RootElement.GetProperty("processed").GetInt32()
            
            Console.WriteLine($"[SyncFNSKU] Synced {processed} FNSKU mappings")
            
            ' Note: Real-time progress requires Supabase Realtime subscription
            ' For simplicity, we just return the total count here
            
            Return processed
            
        Catch ex As Exception
            Console.WriteLine($"[SyncFNSKU] Exception: {ex.Message}")
            Throw New Exception($"Error syncing FNSKU inventory: {ex.Message}", ex)
        End Try
    End Function

    ''' <summary>
    ''' Generate barcode label image for printing
    ''' Same implementation as AmazonFNSKUClient
    ''' </summary>
    Public Function GenerateLabelImage(asin As String, fnsku As String, condition As String, title As String) As Bitmap
        ' Label dimensions: 3.5" x 2" at 203 DPI (thermal printer resolution)
        Dim labelWidth = CInt(3.5 * 203) ' ~710 pixels
        Dim labelHeight = CInt(2.0 * 203) ' ~406 pixels

        Dim bitmap As New Bitmap(labelWidth, labelHeight)
        Using g As Graphics = Graphics.FromImage(bitmap)
            g.Clear(Color.White)
            g.SmoothingMode = Drawing2D.SmoothingMode.AntiAlias
            g.TextRenderingHint = Text.TextRenderingHint.AntiAlias

            Dim padding = 20
            Dim yOffset = padding

            ' Title (truncated to 2 lines max)
            Dim titleFont As New Font("Arial", 11, FontStyle.Bold)
            Dim titleRect As New Rectangle(padding, yOffset, labelWidth - 2 * padding, 50)
            Dim titleFormat As New StringFormat With {
                .Alignment = StringAlignment.Near,
                .LineAlignment = StringAlignment.Near,
                .Trimming = StringTrimming.Word
            }
            g.DrawString(title, titleFont, Brushes.Black, titleRect, titleFormat)
            yOffset += 55

            ' Code type and condition
            Dim infoFont As New Font("Arial", 9, FontStyle.Regular)
            Dim codeType = If(Not String.IsNullOrEmpty(fnsku), "FNSKU", "ASIN")
            Dim barcodeValue = If(Not String.IsNullOrEmpty(fnsku), fnsku, asin)
            
            Dim infoText = $"{codeType}: {barcodeValue}"
            g.DrawString(infoText, infoFont, Brushes.Gray, padding, yOffset)
            yOffset += 20

            ' Condition badge
            Dim conditionFont As New Font("Arial", 9, FontStyle.Bold)
            Dim conditionSize = g.MeasureString(condition, conditionFont)
            Dim conditionRect As New Rectangle(padding, yOffset, CInt(conditionSize.Width) + 10, CInt(conditionSize.Height) + 4)
            g.FillRectangle(New SolidBrush(Color.FromArgb(240, 240, 240)), conditionRect)
            g.DrawString(condition, conditionFont, Brushes.Black, padding + 5, yOffset + 2)
            yOffset += 30

            ' Generate barcode
            Dim barcode As New Barcode()
            barcode.IncludeLabel = True
            barcode.LabelFont = New Font("Arial", 12, FontStyle.Regular)
            barcode.Width = labelWidth - 2 * padding
            barcode.Height = 100
            barcode.BackColor = Color.White

            Dim barcodeImage = barcode.Encode(BarcodeLib.TYPE.CODE128, barcodeValue, barcode.Width, barcode.Height)
            
            ' Center barcode
            Dim barcodeX = (labelWidth - barcodeImage.Width) \ 2
            g.DrawImage(barcodeImage, barcodeX, yOffset)
        End Using

        Return bitmap
    End Function

    ''' <summary>
    ''' Complete workflow: Get FNSKU and generate label for printing
    ''' </summary>
    Public Async Function GetAndPrintLabelAsync(pictureBox As PictureBox, asin As String, title As String) As Task
        Try
            Console.WriteLine($"[PrintLabel] Starting for ASIN: {asin}")
            
            ' Step 1: Get FNSKU via Supabase edge function
            Dim fnskuData = Await GetFNSKUForASINAsync(asin)
            
            If fnskuData Is Nothing Then
                Throw New Exception($"No FNSKU data found for ASIN: {asin}")
            End If
            
            Console.WriteLine($"[PrintLabel] FNSKU: {fnskuData.fnsku}, Condition: {fnskuData.condition}, Source: {fnskuData.source}")
            
            ' Step 2: Generate label
            Dim labelImage = GenerateLabelImage(
                asin,
                fnskuData.fnsku,
                If(fnskuData.condition, "NEW"),
                If(String.IsNullOrEmpty(title), "Product Title", title)
            )
            
            ' Step 3: Display in PictureBox
            pictureBox.Image = labelImage
            pictureBox.SizeMode = PictureBoxSizeMode.Zoom
            
            Console.WriteLine($"[PrintLabel] Label displayed successfully")
            
        Catch ex As Exception
            Console.WriteLine($"[PrintLabel] Error: {ex.Message}")
            MessageBox.Show($"Error generating label: {ex.Message}", "Label Error", MessageBoxButtons.OK, MessageBoxIcon.Error)
            Throw
        End Try
    End Function

End Class

''' <summary>
''' Example usage in a Windows Form
''' </summary>
Public Class FNSKULabelForm
    Inherits Form

    Private WithEvents btnGetLabel As Button
    Private WithEvents txtASIN As TextBox
    Private WithEvents txtTitle As TextBox
    Private WithEvents pictureBox1 As PictureBox
    Private WithEvents lblStatus As Label
    Private fnskuClient As SupabaseFNSKUClient

    Public Sub New()
        InitializeComponent()
        
        ' Initialize Supabase client with your credentials
        Dim supabaseUrl = "https://mstibdszibcheodvnprm.supabase.co"
        Dim supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc"
        
        ' TODO: Get user's access token from Supabase authentication
        ' This should come from your login flow
        Dim userAccessToken = "YOUR_USER_JWT_TOKEN_HERE"
        
        fnskuClient = New SupabaseFNSKUClient(supabaseUrl, supabaseAnonKey, userAccessToken)
    End Sub

    Private Sub InitializeComponent()
        Me.Text = "FNSKU Label Printer (Supabase)"
        Me.Width = 800
        Me.Height = 700
        Me.StartPosition = FormStartPosition.CenterScreen

        ' ASIN input
        Dim lblASIN As New Label With {
            .Text = "ASIN:",
            .Location = New Point(20, 20),
            .Width = 100
        }
        Me.Controls.Add(lblASIN)

        txtASIN = New TextBox With {
            .Location = New Point(120, 20),
            .Width = 200
        }
        Me.Controls.Add(txtASIN)

        ' Title input
        Dim lblTitle As New Label With {
            .Text = "Title:",
            .Location = New Point(20, 50),
            .Width = 100
        }
        Me.Controls.Add(lblTitle)

        txtTitle = New TextBox With {
            .Location = New Point(120, 50),
            .Width = 500,
            .Height = 40,
            .Multiline = True
        }
        Me.Controls.Add(txtTitle)

        ' Get Label button
        btnGetLabel = New Button With {
            .Text = "Get FNSKU & Generate Label",
            .Location = New Point(120, 100),
            .Width = 200,
            .Height = 30
        }
        Me.Controls.Add(btnGetLabel)

        ' Status label
        lblStatus = New Label With {
            .Text = "Ready",
            .Location = New Point(20, 140),
            .Width = 760,
            .Height = 20,
            .ForeColor = Color.Blue
        }
        Me.Controls.Add(lblStatus)

        ' PictureBox for label preview
        pictureBox1 = New PictureBox With {
            .Location = New Point(20, 170),
            .Width = 760,
            .Height = 480,
            .BorderStyle = BorderStyle.FixedSingle,
            .SizeMode = PictureBoxSizeMode.Zoom
        }
        Me.Controls.Add(pictureBox1)
    End Sub

    Private Async Sub btnGetLabel_Click(sender As Object, e As EventArgs) Handles btnGetLabel.Click
        Try
            Dim asin = txtASIN.Text.Trim()
            Dim title = txtTitle.Text.Trim()

            If String.IsNullOrEmpty(asin) Then
                MessageBox.Show("Please enter an ASIN", "Validation Error", MessageBoxButtons.OK, MessageBoxIcon.Warning)
                Return
            End If

            lblStatus.Text = "Fetching FNSKU from Supabase..."
            lblStatus.ForeColor = Color.Blue
            btnGetLabel.Enabled = False

            ' Call Supabase to get FNSKU and generate label
            Await fnskuClient.GetAndPrintLabelAsync(pictureBox1, asin, title)

            lblStatus.Text = "Label ready to print!"
            lblStatus.ForeColor = Color.Green

        Catch ex As Exception
            lblStatus.Text = $"Error: {ex.Message}"
            lblStatus.ForeColor = Color.Red
            MessageBox.Show($"Error: {ex.Message}", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error)
        Finally
            btnGetLabel.Enabled = True
        End Try
    End Sub
End Class
