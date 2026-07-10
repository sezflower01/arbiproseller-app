# Amazon FNSKU Label Printing - Visual Basic .NET Implementation

Complete implementation for retrieving FNSKU (X00 codes) from Amazon SP-API and generating printable thermal labels.

## Features

- **Seller Authorization**: Connect to Amazon SP-API with OAuth 2.0
- **FNSKU Sync**: Retrieve all FBA inventory FNSKU mappings from Amazon reports
- **Label Generation**: Create 3.5"x2" thermal printer labels with barcodes
- **Real-time Progress**: Track sync progress as items are retrieved
- **Database Mapping**: Store FNSKU mappings for fast lookup

## Requirements

### NuGet Packages

```powershell
Install-Package System.Text.Json
Install-Package BarcodeLib
```

### Credentials Required

1. **AWS IAM Credentials** (for SP-API signing):
   - AWS Access Key ID
   - AWS Secret Access Key
   - AWS Region (e.g., "us-east-1")

2. **LWA Credentials** (Login with Amazon OAuth):
   - LWA Client ID
   - LWA Client Secret
   - LWA Refresh Token (obtained via OAuth flow)

3. **Seller Information**:
   - Seller ID (from Amazon Seller Central)
   - Marketplace ID (e.g., "ATVPDKIKX0DER" for US)

## Quick Start

### 1. Initialize Client

```vb
Imports AmazonFNSKULibrary

' Initialize with your credentials
Dim client As New AmazonFNSKUClient(
    awsAccessKey:="YOUR_AWS_ACCESS_KEY",
    awsSecretKey:="YOUR_AWS_SECRET_KEY",
    region:="us-east-1",
    lwaClient:="YOUR_LWA_CLIENT_ID",
    lwaSecret:="YOUR_LWA_CLIENT_SECRET",
    lwaRefresh:="YOUR_LWA_REFRESH_TOKEN",
    seller:="YOUR_SELLER_ID",
    marketplace:="ATVPDKIKX0DER"
)
```

### 2. Sync FNSKU Mappings

```vb
' Sync all FNSKU from Amazon inventory with progress callback
Private Async Sub SyncFNSKU()
    Try
        lblStatus.Text = "Syncing FNSKU mappings from Amazon..."
        
        Dim count = Await client.SyncAllFNSKUAsync(
            Sub(asin As String, fnsku As String, condition As String)
                ' Update progress in UI
                lstProgress.Items.Add($"ASIN: {asin} → FNSKU: {fnsku} (Condition: {condition})")
                Application.DoEvents()
            End Sub
        )
        
        lblStatus.Text = $"Sync complete! Retrieved {count} FNSKU mappings."
        MessageBox.Show($"Successfully synced {count} products!", "Success")
    Catch ex As Exception
        MessageBox.Show($"Sync failed: {ex.Message}", "Error")
    End Try
End Sub
```

### 3. Print Label to PictureBox

```vb
' Generate and display label in PictureBox (Picture1)
Private Async Sub PrintLabel()
    Try
        Dim asin = txtASIN.Text.Trim()
        
        If String.IsNullOrEmpty(asin) Then
            MessageBox.Show("Please enter an ASIN", "Input Required")
            Return
        End If
        
        ' Generate label and display in PictureBox
        Await client.PrintLabelToPictureBoxAsync(Picture1, asin)
        
        lblStatus.Text = $"Label ready for ASIN: {asin}"
    Catch ex As Exception
        MessageBox.Show($"Label generation failed: {ex.Message}", "Error")
    End Try
End Sub
```

### 4. Print Label to Physical Printer

```vb
' Print label to default printer
Private Sub PrintLabelToThermalPrinter()
    Try
        If Picture1.Image Is Nothing Then
            MessageBox.Show("Generate a label first", "No Label")
            Return
        End If
        
        ' Create print document
        Dim printDoc As New Printing.PrintDocument()
        
        AddHandler printDoc.PrintPage, Sub(sender, e)
            ' Print label at 203 DPI (thermal printer standard)
            Dim labelImage = Picture1.Image
            Dim destRect As New Rectangle(0, 0, CInt(3.5 * 203), CInt(2.0 * 203))
            e.Graphics.DrawImage(labelImage, destRect)
        End Sub
        
        ' Print
        printDoc.Print()
        
        MessageBox.Show("Label sent to printer!", "Success")
    Catch ex As Exception
        MessageBox.Show($"Print failed: {ex.Message}", "Error")
    End Try
End Sub
```

## Complete Form Example

```vb
Public Class FrmLabelPrinting
    Private client As AmazonFNSKUClient
    
    Private Sub FrmLabelPrinting_Load(sender As Object, e As EventArgs) Handles MyBase.Load
        ' Initialize client
        client = New AmazonFNSKUClient(
            awsAccessKey:=Environment.GetEnvironmentVariable("AWS_ACCESS_KEY_ID"),
            awsSecretKey:=Environment.GetEnvironmentVariable("AWS_SECRET_ACCESS_KEY"),
            region:="us-east-1",
            lwaClient:=Environment.GetEnvironmentVariable("LWA_CLIENT_ID"),
            lwaSecret:=Environment.GetEnvironmentVariable("LWA_CLIENT_SECRET"),
            lwaRefresh:=Environment.GetEnvironmentVariable("LWA_REFRESH_TOKEN"),
            seller:=Environment.GetEnvironmentVariable("SELLER_ID"),
            marketplace:="ATVPDKIKX0DER"
        )
    End Sub
    
    Private Async Sub btnSync_Click(sender As Object, e As EventArgs) Handles btnSync.Click
        btnSync.Enabled = False
        lstProgress.Items.Clear()
        
        Try
            Dim count = Await client.SyncAllFNSKUAsync(
                Sub(asin, fnsku, condition)
                    lstProgress.Items.Add($"{asin} → {fnsku} ({condition})")
                    lstProgress.TopIndex = lstProgress.Items.Count - 1
                    Application.DoEvents()
                End Sub
            )
            
            MessageBox.Show($"Synced {count} products!", "Success")
        Catch ex As Exception
            MessageBox.Show($"Sync failed: {ex.Message}", "Error")
        Finally
            btnSync.Enabled = True
        End Try
    End Sub
    
    Private Async Sub btnGenerate_Click(sender As Object, e As EventArgs) Handles btnGenerate.Click
        If String.IsNullOrEmpty(txtASIN.Text) Then
            MessageBox.Show("Enter an ASIN", "Input Required")
            Return
        End If
        
        Try
            Await client.PrintLabelToPictureBoxAsync(Picture1, txtASIN.Text.Trim())
            btnPrint.Enabled = True
        Catch ex As Exception
            MessageBox.Show($"Label generation failed: {ex.Message}", "Error")
        End Try
    End Sub
    
    Private Sub btnPrint_Click(sender As Object, e As EventArgs) Handles btnPrint.Click
        If Picture1.Image Is Nothing Then Return
        
        Dim printDoc As New Printing.PrintDocument()
        AddHandler printDoc.PrintPage, Sub(s, args)
            Dim destRect As New Rectangle(0, 0, CInt(3.5 * 203), CInt(2.0 * 203))
            args.Graphics.DrawImage(Picture1.Image, destRect)
        End Sub
        
        printDoc.Print()
        MessageBox.Show("Label sent to printer!", "Success")
    End Sub
End Class
```

## Form Designer Layout

Add these controls to your form:

**Controls:**
- `txtASIN` (TextBox) - ASIN input
- `btnSync` (Button) - "Sync All FNSKU from Amazon"
- `btnGenerate` (Button) - "Generate Label"
- `btnPrint` (Button) - "Print Label"
- `Picture1` (PictureBox) - Label preview (710x406 pixels)
- `lstProgress` (ListBox) - Sync progress display
- `lblStatus` (Label) - Status messages

## Data Model

### FNSKUMapping Class

```vb
Public Class FNSKUMapping
    Public Property ASIN As String          ' Amazon Standard Identification Number
    Public Property FNSKU As String         ' Fulfillment Network SKU (X00 code)
    Public Property SellerSKU As String     ' Your seller SKU
    Public Property Condition As String     ' NEW, USED - LIKE NEW, etc.
    Public Property Title As String         ' Product title
    Public Property ImageUrl As String      ' Product image URL
End Class
```

## How It Works

### 1. FNSKU Sync Process

1. **Create Report**: Calls SP-API Reports endpoint to create `GET_FBA_MYI_ALL_INVENTORY_DATA` report
2. **Poll Status**: Checks report status every 5 seconds until complete
3. **Download Report**: Gets report document URL and downloads TSV file
4. **Parse Data**: Extracts ASIN, FNSKU, SKU, and condition from each row
5. **Store Mappings**: Saves mappings in memory dictionary (can replace with database)
6. **Progress Callback**: Notifies UI for each processed item

### 2. Label Generation

1. **Lookup FNSKU**: Gets FNSKU from synced mappings
2. **Fetch Product Info**: Calls Catalog Items API to get title and image
3. **Generate Barcode**: Creates CODE128 barcode with FNSKU (or ASIN if no FNSKU)
4. **Render Label**: Draws 3.5"x2" thermal label with title, condition, and barcode
5. **Display**: Shows label in PictureBox for preview

### 3. AWS Signature V4 Signing

All SP-API requests require AWS SigV4 signing:
- Canonical request construction
- String to sign generation
- HMAC-SHA256 signing key derivation
- Authorization header generation

## Condition Normalization

Amazon returns various condition formats. The system normalizes them:

| Amazon Format | Normalized |
|--------------|-----------|
| `SELLABLE`, `NEW` | NEW |
| `USED_LIKE_NEW` | USED - LIKE NEW |
| `USED_VERY_GOOD` | USED - VERY GOOD |
| `USED_GOOD` | USED - GOOD |
| `USED_ACCEPTABLE` | USED - ACCEPTABLE |
| `COLLECTIBLE_*` | COLLECTIBLE - * |
| `REFURBISHED`, `RENEWED` | RENEWED |

## Error Handling

```vb
Try
    Await client.SyncAllFNSKUAsync(progressCallback)
Catch ex As HttpRequestException
    ' Network error
    MessageBox.Show($"Network error: {ex.Message}")
Catch ex As JsonException
    ' JSON parsing error
    MessageBox.Show($"Data format error: {ex.Message}")
Catch ex As Exception
    ' Other errors
    MessageBox.Show($"Error: {ex.Message}")
End Try
```

## Credential Storage

**Option 1: Environment Variables** (Recommended)
```vb
Dim awsKey = Environment.GetEnvironmentVariable("AWS_ACCESS_KEY_ID")
```

**Option 2: App.config**
```xml
<appSettings>
  <add key="AWS_ACCESS_KEY_ID" value="YOUR_KEY"/>
  <add key="AWS_SECRET_ACCESS_KEY" value="YOUR_SECRET"/>
</appSettings>
```

**Option 3: Secure Storage** (Windows)
```vb
' Store securely in Windows Credential Manager
Dim credential As New NetworkCredential("AWS_ACCESS_KEY_ID", "YOUR_KEY")
```

## Performance Tips

1. **Sync Once**: Sync FNSKU mappings once per day, store in database
2. **Cache Product Info**: Cache product titles/images to avoid repeated API calls
3. **Batch Operations**: Print multiple labels at once
4. **Rate Limiting**: SP-API has rate limits, implement backoff for 429 errors

## Troubleshooting

**Problem: "403 Forbidden" errors**
- Check AWS credentials are correct
- Verify IAM policy has SP-API permissions
- Ensure AWS region matches your SP-API app registration

**Problem: "Invalid refresh token"**
- Re-authorize via Amazon OAuth flow
- Check LWA credentials match your SP-API app

**Problem: "No FNSKU found for ASIN"**
- ASIN may not be in FBA inventory
- Product may be stickerless (FNSKU = ASIN)
- Sync may not have completed yet

**Problem: Barcode won't scan**
- Ensure thermal printer is 203 DPI
- Use CODE128 barcode format (required by Amazon)
- Print at correct size (3.5"x2")

## Resources

- [Amazon SP-API Documentation](https://developer-docs.amazon.com/sp-api/)
- [SP-API Reports API Reference](https://developer-docs.amazon.com/sp-api/docs/reports-api-v2021-06-30-reference)
- [FBA Inventory Reports](https://developer-docs.amazon.com/sp-api/docs/fba-inventory-reports)
- [AWS Signature V4](https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html)

## Support

For issues with:
- **SP-API**: Amazon Seller Central Support
- **AWS Credentials**: AWS IAM Documentation
- **This Code**: Open GitHub issue

## License

MIT License - Free to use and modify
