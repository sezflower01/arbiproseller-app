Imports System.Net.Http
Imports System.Text
Imports System.Security.Cryptography
Imports System.Text.Json
Imports System.Threading.Tasks
Imports System.Collections.Generic
Imports System.Drawing
Imports System.Drawing.Imaging
Imports BarcodeLib ' Install-Package BarcodeLib via NuGet

''' <summary>
''' Amazon SP-API Client for FNSKU Retrieval and Label Printing
''' Handles seller authorization, FNSKU mapping sync, and barcode label generation
''' </summary>
Public Class AmazonFNSKUClient
    Private ReadOnly awsAccessKeyId As String
    Private ReadOnly awsSecretAccessKey As String
    Private ReadOnly awsRegion As String
    Private ReadOnly lwaClientId As String
    Private ReadOnly lwaClientSecret As String
    Private ReadOnly lwaRefreshToken As String
    Private ReadOnly sellerId As String
    Private ReadOnly marketplaceId As String
    Private ReadOnly httpClient As HttpClient

    ' Database connection for FNSKU mapping storage
    Private fnskuMappings As New Dictionary(Of String, FNSKUMapping)

    ''' <summary>
    ''' Initialize the Amazon SP-API client
    ''' </summary>
    Public Sub New(
        awsAccessKey As String,
        awsSecretKey As String,
        region As String,
        lwaClient As String,
        lwaSecret As String,
        lwaRefresh As String,
        seller As String,
        marketplace As String
    )
        Me.awsAccessKeyId = awsAccessKey
        Me.awsSecretAccessKey = awsSecretKey
        Me.awsRegion = region
        Me.lwaClientId = lwaClient
        Me.lwaClientSecret = lwaSecret
        Me.lwaRefreshToken = lwaRefresh
        Me.sellerId = seller
        Me.marketplaceId = marketplace
        Me.httpClient = New HttpClient()
    End Sub

    ''' <summary>
    ''' Data model for FNSKU mapping
    ''' </summary>
    Public Class FNSKUMapping
        Public Property ASIN As String
        Public Property FNSKU As String
        Public Property SellerSKU As String
        Public Property Condition As String
        Public Property Title As String
        Public Property ImageUrl As String
    End Class

    ''' <summary>
    ''' Data model for LWA token response
    ''' </summary>
    Private Class LWATokenResponse
        Public Property access_token As String
        Public Property token_type As String
        Public Property expires_in As Integer
        Public Property refresh_token As String
    End Class

    ''' <summary>
    ''' AWS Signature V4 signing helpers
    ''' </summary>
    Private Function GetSignatureKey(key As String, dateStamp As String, regionName As String, serviceName As String) As Byte()
        Dim kDate = ComputeHMACSHA256(Encoding.UTF8.GetBytes("AWS4" & key), Encoding.UTF8.GetBytes(dateStamp))
        Dim kRegion = ComputeHMACSHA256(kDate, Encoding.UTF8.GetBytes(regionName))
        Dim kService = ComputeHMACSHA256(kRegion, Encoding.UTF8.GetBytes(serviceName))
        Return ComputeHMACSHA256(kService, Encoding.UTF8.GetBytes("aws4_request"))
    End Function

    Private Function ComputeHMACSHA256(key As Byte(), data As Byte()) As Byte()
        Using hmac As New HMACSHA256(key)
            Return hmac.ComputeHash(data)
        End Using
    End Function

    Private Function ComputeSHA256Hash(data As String) As String
        Using sha256 As SHA256 = SHA256.Create()
            Dim bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(data))
            Return ByteArrayToHexString(bytes)
        End Using
    End Function

    Private Function ByteArrayToHexString(bytes As Byte()) As String
        Dim sb As New StringBuilder()
        For Each b In bytes
            sb.Append(b.ToString("x2"))
        Next
        Return sb.ToString()
    End Function

    ''' <summary>
    ''' Sign SP-API request with AWS Signature V4
    ''' </summary>
    Private Function SignRequestAsync(method As String, path As String, queryString As String, payload As String) As Task(Of Dictionary(Of String, String))
        Return Task.Run(Function()
            Dim host = $"sellingpartnerapi-na.amazon.com"
            Dim service = "execute-api"
            Dim now = DateTime.UtcNow
            Dim amzDate = now.ToString("yyyyMMddTHHmmssZ")
            Dim dateStamp = now.ToString("yyyyMMdd")

            Dim canonicalUri = path
            Dim canonicalQuerystring = queryString
            Dim payloadHash = ComputeSHA256Hash(payload)

            Dim canonicalHeaders = $"host:{host}" & vbLf & $"x-amz-date:{amzDate}" & vbLf
            Dim signedHeaders = "host;x-amz-date"

            Dim canonicalRequest = $"{method}" & vbLf &
                                 $"{canonicalUri}" & vbLf &
                                 $"{canonicalQuerystring}" & vbLf &
                                 $"{canonicalHeaders}" & vbLf &
                                 $"{signedHeaders}" & vbLf &
                                 $"{payloadHash}"

            Dim algorithm = "AWS4-HMAC-SHA256"
            Dim credentialScope = $"{dateStamp}/{awsRegion}/{service}/aws4_request"
            Dim stringToSign = $"{algorithm}" & vbLf &
                             $"{amzDate}" & vbLf &
                             $"{credentialScope}" & vbLf &
                             $"{ComputeSHA256Hash(canonicalRequest)}"

            Dim signingKey = GetSignatureKey(awsSecretAccessKey, dateStamp, awsRegion, service)
            Dim signature = ByteArrayToHexString(ComputeHMACSHA256(signingKey, Encoding.UTF8.GetBytes(stringToSign)))

            Dim authorizationHeader = $"{algorithm} Credential={awsAccessKeyId}/{credentialScope}, SignedHeaders={signedHeaders}, Signature={signature}"

            Return New Dictionary(Of String, String) From {
                {"Authorization", authorizationHeader},
                {"x-amz-date", amzDate}
            }
        End Function)
    End Function

    ''' <summary>
    ''' Get LWA access token
    ''' </summary>
    Private Async Function GetLWAAccessTokenAsync() As Task(Of String)
        Dim tokenUrl = "https://api.amazon.com/auth/o2/token"
        Dim content = New FormUrlEncodedContent(New Dictionary(Of String, String) From {
            {"grant_type", "refresh_token"},
            {"refresh_token", lwaRefreshToken},
            {"client_id", lwaClientId},
            {"client_secret", lwaClientSecret}
        })

        Dim response = Await httpClient.PostAsync(tokenUrl, content)
        Dim responseBody = Await response.Content.ReadAsStringAsync()

        If Not response.IsSuccessStatusCode Then
            Throw New Exception($"LWA token error: {response.StatusCode} - {responseBody}")
        End If

        Dim tokenResponse = JsonSerializer.Deserialize(Of LWATokenResponse)(responseBody)
        Return tokenResponse.access_token
    End Function

    ''' <summary>
    ''' Call SP-API with AWS signature
    ''' </summary>
    Private Async Function CallSpApiAsync(path As String, queryParams As Dictionary(Of String, String), Optional method As String = "GET") As Task(Of String)
        Dim accessToken = Await GetLWAAccessTokenAsync()
        Dim queryString = If(queryParams IsNot Nothing, String.Join("&", queryParams.Select(Function(kv) $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}")), "")
        Dim payload = ""

        Dim signature = Await SignRequestAsync(method, path, queryString, payload)

        Dim url = $"https://sellingpartnerapi-na.amazon.com{path}"
        If Not String.IsNullOrEmpty(queryString) Then
            url &= "?" & queryString
        End If

        Dim request = New HttpRequestMessage(New HttpMethod(method), url)
        request.Headers.TryAddWithoutValidation("Authorization", signature("Authorization"))
        request.Headers.TryAddWithoutValidation("x-amz-date", signature("x-amz-date"))
        request.Headers.TryAddWithoutValidation("x-amz-access-token", accessToken)

        Dim response = Await httpClient.SendAsync(request)
        Dim responseBody = Await response.Content.ReadAsStringAsync()

        If Not response.IsSuccessStatusCode Then
            Throw New Exception($"SP-API error: {response.StatusCode} - {responseBody}")
        End If

        Return responseBody
    End Function

    ''' <summary>
    ''' Sync all FNSKU mappings from Amazon FBA inventory report
    ''' </summary>
    Public Async Function SyncAllFNSKUAsync(progressCallback As Action(Of String, String, String)) As Task(Of Integer)
        Console.WriteLine("Starting FNSKU sync from Amazon FBA inventory report...")

        ' Step 1: Create report
        Dim createPath = "/reports/2021-06-30/reports"
        Dim createParams = New Dictionary(Of String, String) From {
            {"reportType", "GET_FBA_MYI_ALL_INVENTORY_DATA"},
            {"marketplaceIds", marketplaceId}
        }
        Dim createPayload = JsonSerializer.Serialize(New With {
            .reportType = "GET_FBA_MYI_ALL_INVENTORY_DATA",
            .marketplaceIds = New String() {marketplaceId}
        })

        Dim accessToken = Await GetLWAAccessTokenAsync()
        Dim signature = Await SignRequestAsync("POST", createPath, "", createPayload)

        Dim createUrl = $"https://sellingpartnerapi-na.amazon.com{createPath}"
        Dim createRequest = New HttpRequestMessage(HttpMethod.Post, createUrl)
        createRequest.Headers.TryAddWithoutValidation("Authorization", signature("Authorization"))
        createRequest.Headers.TryAddWithoutValidation("x-amz-date", signature("x-amz-date"))
        createRequest.Headers.TryAddWithoutValidation("x-amz-access-token", accessToken)
        createRequest.Content = New StringContent(createPayload, Encoding.UTF8, "application/json")

        Dim createResponse = Await httpClient.SendAsync(createRequest)
        Dim createBody = Await createResponse.Content.ReadAsStringAsync()

        If Not createResponse.IsSuccessStatusCode Then
            Throw New Exception($"Failed to create report: {createResponse.StatusCode} - {createBody}")
        End If

        Dim createResult = JsonDocument.Parse(createBody)
        Dim reportId = createResult.RootElement.GetProperty("reportId").GetString()
        Console.WriteLine($"Report created: {reportId}")

        ' Step 2: Poll for completion
        Dim reportPath = $"/reports/2021-06-30/reports/{reportId}"
        Dim reportUrl As String = Nothing
        Dim maxAttempts = 60
        Dim attempt = 0

        While attempt < maxAttempts
            attempt += 1
            Await Task.Delay(5000) ' Wait 5 seconds

            Dim statusResponse = Await CallSpApiAsync(reportPath, Nothing)
            Dim statusResult = JsonDocument.Parse(statusResponse)
            Dim processingStatus = statusResult.RootElement.GetProperty("processingStatus").GetString()

            Console.WriteLine($"Report status: {processingStatus} (attempt {attempt}/{maxAttempts})")

            If processingStatus = "DONE" Then
                reportUrl = statusResult.RootElement.GetProperty("reportDocumentId").GetString()
                Exit While
            ElseIf processingStatus = "FATAL" Or processingStatus = "CANCELLED" Then
                Throw New Exception($"Report failed with status: {processingStatus}")
            End If
        End While

        If String.IsNullOrEmpty(reportUrl) Then
            Throw New Exception("Report generation timeout")
        End If

        ' Step 3: Get report document
        Dim docPath = $"/reports/2021-06-30/documents/{reportUrl}"
        Dim docResponse = Await CallSpApiAsync(docPath, Nothing)
        Dim docResult = JsonDocument.Parse(docResponse)
        Dim downloadUrl = docResult.RootElement.GetProperty("url").GetString()

        Console.WriteLine($"Downloading report from: {downloadUrl}")

        ' Step 4: Download and parse report
        Dim reportData = Await httpClient.GetStringAsync(downloadUrl)
        Dim lines = reportData.Split(vbLf)

        If lines.Length < 2 Then
            Throw New Exception("Empty report")
        End If

        Dim headers = lines(0).Split(vbTab)
        Dim asinIndex = Array.IndexOf(headers, "asin")
        Dim fnskuIndex = Array.IndexOf(headers, "fnsku")
        Dim skuIndex = Array.IndexOf(headers, "seller-sku")
        Dim conditionIndex = Array.IndexOf(headers, "condition")

        If asinIndex = -1 Or fnskuIndex = -1 Then
            Throw New Exception("Required columns not found in report")
        End If

        Console.WriteLine($"Found {lines.Length - 1} rows in report")

        ' Step 5: Process mappings
        Dim processedCount = 0
        For i = 1 To lines.Length - 1
            Dim columns = lines(i).Split(vbTab)
            If columns.Length <= Math.Max(asinIndex, fnskuIndex) Then Continue For

            Dim asin = columns(asinIndex).Trim()
            Dim fnsku = columns(fnskuIndex).Trim()
            Dim sku = If(skuIndex >= 0 AndAlso skuIndex < columns.Length, columns(skuIndex).Trim(), "")
            Dim condition = If(conditionIndex >= 0 AndAlso conditionIndex < columns.Length, NormalizeCondition(columns(conditionIndex).Trim()), "NEW")

            If String.IsNullOrEmpty(asin) Or String.IsNullOrEmpty(fnsku) Then Continue For

            ' Store in memory dictionary (you can replace with database storage)
            fnskuMappings(asin) = New FNSKUMapping With {
                .ASIN = asin,
                .FNSKU = fnsku,
                .SellerSKU = sku,
                .Condition = condition
            }

            processedCount += 1

            ' Report progress
            If progressCallback IsNot Nothing Then
                progressCallback(asin, fnsku, condition)
            End If
        Next

        Console.WriteLine($"Synced {processedCount} FNSKU mappings")
        Return processedCount
    End Function

    ''' <summary>
    ''' Normalize condition string
    ''' </summary>
    Private Function NormalizeCondition(rawCondition As String) As String
        If String.IsNullOrEmpty(rawCondition) Then Return "NEW"

        Dim condition = rawCondition.ToUpper().Trim()

        Select Case condition
            Case "SELLABLE", "NEW", "NEW_NEW"
                Return "NEW"
            Case "USED_LIKE_NEW", "USEDLIKENEW"
                Return "USED - LIKE NEW"
            Case "USED_VERY_GOOD", "USEDVERYGOOD"
                Return "USED - VERY GOOD"
            Case "USED_GOOD", "USEDGOOD"
                Return "USED - GOOD"
            Case "USED_ACCEPTABLE", "USEDACCEPTABLE"
                Return "USED - ACCEPTABLE"
            Case "COLLECTIBLE_LIKE_NEW"
                Return "COLLECTIBLE - LIKE NEW"
            Case "COLLECTIBLE_VERY_GOOD"
                Return "COLLECTIBLE - VERY GOOD"
            Case "COLLECTIBLE_GOOD"
                Return "COLLECTIBLE - GOOD"
            Case "COLLECTIBLE_ACCEPTABLE"
                Return "COLLECTIBLE - ACCEPTABLE"
            Case "REFURBISHED", "RENEWED"
                Return "RENEWED"
            Case Else
                Return condition
        End Select
    End Function

    ''' <summary>
    ''' Get FNSKU for an ASIN
    ''' </summary>
    Public Function GetFNSKUForASIN(asin As String) As FNSKUMapping
        If fnskuMappings.ContainsKey(asin) Then
            Return fnskuMappings(asin)
        End If
        Return Nothing
    End Function

    ''' <summary>
    ''' Get product info from Catalog Items API
    ''' </summary>
    Public Async Function GetProductInfoAsync(asin As String) As Task(Of FNSKUMapping)
        Dim path = $"/catalog/2022-04-01/items/{asin}"
        Dim queryParams = New Dictionary(Of String, String) From {
            {"marketplaceIds", marketplaceId},
            {"includedData", "summaries,images"}
        }

        Dim response = Await CallSpApiAsync(path, queryParams)
        Dim result = JsonDocument.Parse(response)

        Dim mapping = New FNSKUMapping With {
            .ASIN = asin
        }

        Try
            Dim summaries = result.RootElement.GetProperty("summaries")
            If summaries.GetArrayLength() > 0 Then
                Dim summary = summaries(0)
                mapping.Title = summary.GetProperty("itemName").GetString()
            End If

            Dim images = result.RootElement.GetProperty("images")
            If images.GetArrayLength() > 0 Then
                Dim imageSet = images(0)
                Dim variants = imageSet.GetProperty("images")
                If variants.GetArrayLength() > 0 Then
                    mapping.ImageUrl = variants(0).GetProperty("link").GetString()
                End If
            End If
        Catch ex As Exception
            Console.WriteLine($"Error parsing product info: {ex.Message}")
        End Try

        Return mapping
    End Function

    ''' <summary>
    ''' Generate barcode label image for printing
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
    ''' Print label to PictureBox for preview
    ''' </summary>
    Public Async Function PrintLabelToPictureBoxAsync(pictureBox As PictureBox, asin As String) As Task
        ' Get FNSKU mapping
        Dim mapping = GetFNSKUForASIN(asin)
        
        ' If no mapping, fetch product info
        If mapping Is Nothing Then
            mapping = Await GetProductInfoAsync(asin)
            mapping.ASIN = asin
            mapping.FNSKU = Nothing
            mapping.Condition = "NEW"
        End If

        ' Generate label
        Dim labelImage = GenerateLabelImage(
            mapping.ASIN,
            mapping.FNSKU,
            If(mapping.Condition, "NEW"),
            If(mapping.Title, "Product Title")
        )

        ' Display in PictureBox
        pictureBox.Image = labelImage
        pictureBox.SizeMode = PictureBoxSizeMode.Zoom
    End Function

End Class
