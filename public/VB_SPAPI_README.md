# Amazon SP-API Integration for Visual Basic .NET

Complete Visual Basic .NET implementation for Amazon Selling Partner API with AWS Signature V4 signing, ROI calculation, and product lookup.

## 📋 Requirements

- .NET Framework 4.7.2 or higher (or .NET Core 3.1+)
- NuGet Packages:
  - `System.Text.Json` (for JSON parsing)
  - `System.Net.Http` (included in .NET)

## 🔑 Required Credentials

You need the following credentials from your AWS and Amazon SP-API setup:

1. **AWS IAM User Credentials** (from AWS Console)
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION` (e.g., "us-east-1")

2. **SP-API LWA Credentials** (from Amazon Seller Central)
   - `SPAPI_LWA_CLIENT_ID`
   - `SPAPI_LWA_CLIENT_SECRET`
   - `SPAPI_REFRESH_TOKEN`

## 🚀 Quick Start

### 1. Add the Class to Your Project

Copy the `AmazonSPAPI_VB.vb` file to your Visual Basic .NET project.

### 2. Install Required NuGet Package

```bash
Install-Package System.Text.Json
```

### 3. Initialize the Client

```vb
Imports System

Dim client As New AmazonSPAPIClient(
    awsAccessKey:="YOUR_AWS_ACCESS_KEY_ID",
    awsSecretKey:="YOUR_AWS_SECRET_ACCESS_KEY",
    lwaClientId:="YOUR_SPAPI_LWA_CLIENT_ID",
    lwaClientSecret:="YOUR_SPAPI_LWA_CLIENT_SECRET",
    lwaRefreshToken:="YOUR_SPAPI_REFRESH_TOKEN",
    region:="us-east-1"
)
```

### 4. Calculate ROI for an ASIN

```vb
' Calculate ROI with buy cost
Dim result = Await client.CalculateRoiForAsinAsync("B019PXKQK6", 12D)

Console.WriteLine($"ASIN: {result.Asin}")
Console.WriteLine($"Title: {result.Title}")
Console.WriteLine($"Amazon Price: ${result.Price}")
Console.WriteLine($"ROI: {result.Calculation.Roi}%")
Console.WriteLine($"Profit: ${result.Calculation.Profit}")
Console.WriteLine($"Total Fees: ${result.Calculation.TotalFees}")
```

### 5. Get Product Info Without ROI

```vb
' Get product information only
Dim productInfo = Await client.GetProductInfoAsync("B019PXKQK6")

Console.WriteLine($"Title: {productInfo.Title}")
Console.WriteLine($"Price: ${productInfo.Price}")
Console.WriteLine($"Image URL: {productInfo.ImageUrl}")
```

## 📊 Available Methods

### `CalculateRoiForAsinAsync(asin As String, Optional buyCost As Decimal?)`

Retrieves product information from Amazon SP-API and calculates ROI if buy cost is provided.

**Returns:** `RoiResult` object containing:
- ASIN
- Title
- Image URL
- Current Amazon Price
- Price Source (e.g., "buybox", "competitive_pricing")
- Product Link
- Calculation breakdown (if cost provided)

**Example:**
```vb
Dim result = Await client.CalculateRoiForAsinAsync("B08N5WRWNW", 25.50D)
```

### `GetProductInfoAsync(asin As String)`

Retrieves product information without calculating ROI.

**Returns:** `ProductData` object

**Example:**
```vb
Dim product = Await client.GetProductInfoAsync("B08N5WRWNW")
```

### `CalculateRoi(amzPrice As Decimal, buyCost As Decimal, Optional actualFees As ActualFees)`

Calculates ROI and profit margins based on price and costs.

**Returns:** `FeeBreakdown` object with:
- Referral Fee
- FBA Fee
- Variable Closing Fee
- Other Fees
- Total Fees
- Profit
- ROI %
- Margin %

**Example:**
```vb
Dim fees = New ActualFees With {
    .ReferralFee = 4.20D,
    .FbaFee = 4.84D,
    .VariableClosingFee = 1.80D,
    .OtherFees = 0D
}
Dim calculation = client.CalculateRoi(27.97D, 12D, fees)
```

## 🔐 Storing Credentials Securely

### Option 1: App.config / Web.config

```xml
<configuration>
  <appSettings>
    <add key="AWS_ACCESS_KEY_ID" value="YOUR_KEY_HERE"/>
    <add key="AWS_SECRET_ACCESS_KEY" value="YOUR_SECRET_HERE"/>
    <add key="SPAPI_LWA_CLIENT_ID" value="YOUR_CLIENT_ID"/>
    <add key="SPAPI_LWA_CLIENT_SECRET" value="YOUR_CLIENT_SECRET"/>
    <add key="SPAPI_REFRESH_TOKEN" value="YOUR_REFRESH_TOKEN"/>
  </appSettings>
</configuration>
```

Then read from config:
```vb
Imports System.Configuration

Dim client As New AmazonSPAPIClient(
    awsAccessKey:=ConfigurationManager.AppSettings("AWS_ACCESS_KEY_ID"),
    awsSecretKey:=ConfigurationManager.AppSettings("AWS_SECRET_ACCESS_KEY"),
    lwaClientId:=ConfigurationManager.AppSettings("SPAPI_LWA_CLIENT_ID"),
    lwaClientSecret:=ConfigurationManager.AppSettings("SPAPI_LWA_CLIENT_SECRET"),
    lwaRefreshToken:=ConfigurationManager.AppSettings("SPAPI_REFRESH_TOKEN")
)
```

### Option 2: Environment Variables

```vb
Dim client As New AmazonSPAPIClient(
    awsAccessKey:=Environment.GetEnvironmentVariable("AWS_ACCESS_KEY_ID"),
    awsSecretKey:=Environment.GetEnvironmentVariable("AWS_SECRET_ACCESS_KEY"),
    lwaClientId:=Environment.GetEnvironmentVariable("SPAPI_LWA_CLIENT_ID"),
    lwaClientSecret:=Environment.GetEnvironmentVariable("SPAPI_LWA_CLIENT_SECRET"),
    lwaRefreshToken:=Environment.GetEnvironmentVariable("SPAPI_REFRESH_TOKEN")
)
```

## 📝 Data Models

### RoiResult
```vb
Public Class RoiResult
    Public Property Asin As String
    Public Property Title As String
    Public Property ImageUrl As String
    Public Property Price As Decimal
    Public Property PriceSource As String
    Public Property Link As String
    Public Property Calculation As FeeBreakdown
End Class
```

### FeeBreakdown
```vb
Public Class FeeBreakdown
    Public Property ReferralFee As Decimal
    Public Property FbaFee As Decimal
    Public Property VariableClosingFee As Decimal
    Public Property OtherFees As Decimal
    Public Property TotalFees As Decimal
    Public Property Profit As Decimal
    Public Property Roi As Decimal
    Public Property Margin As Decimal
End Class
```

### ProductData
```vb
Public Class ProductData
    Public Property Asin As String
    Public Property Title As String
    Public Property ImageUrl As String
    Public Property Price As Decimal
    Public Property PriceSource As String
    Public Property Link As String
    Public Property Fees As ActualFees
End Class
```

## ⚙️ How It Works

### 1. AWS Signature V4 Signing
The class implements AWS Signature Version 4 signing to authenticate requests to Amazon's SP-API. This includes:
- Creating canonical requests
- Computing SHA-256 hashes
- Generating HMAC-SHA256 signatures
- Building authorization headers

### 2. LWA Token Authentication
Before making SP-API requests, the client:
1. Exchanges your refresh token for a temporary access token
2. Uses this access token in all SP-API requests
3. Tokens are valid for 1 hour

### 3. Product Data Retrieval
The client fetches data from multiple SP-API endpoints:
- **Catalog API**: Product title, images, attributes
- **Pricing API**: Current Buy Box price, competitive pricing
- **Fees API**: Amazon referral fees, FBA fees, closing fees

### 4. ROI Calculation
Calculates profitability metrics:
```
Profit = Amazon Price - Buy Cost - Total Fees
ROI % = (Profit / Buy Cost) × 100
Margin % = (Profit / Amazon Price) × 100
```

## 🛠️ Error Handling

The class throws exceptions with descriptive messages:

```vb
Try
    Dim result = Await client.CalculateRoiForAsinAsync("B08N5WRWNW", 25D)
Catch ex As Exception
    Console.WriteLine($"Error: {ex.Message}")
    ' Handle error appropriately
End Try
```

Common errors:
- `"Missing AWS credentials"` - AWS keys not provided
- `"Missing SP-API credentials"` - LWA credentials not provided
- `"LWA token error: 401"` - Invalid LWA credentials
- `"SP-API authentication failed: 403"` - Invalid AWS credentials or missing permissions
- `"SP-API Fees calculation failed: 429"` - Rate limit exceeded

## 🌍 Marketplace Support

Current implementation uses US marketplace (`ATVPDKIKX0DER`). To support other marketplaces:

```vb
' UK Marketplace
Private ReadOnly MarketplaceId As String = "A1F83G8C2ARO7P"

' Change endpoint region
Dim catalogUrl As String = $"https://sellingpartnerapi-eu.amazon.com/..."
```

**Marketplace IDs:**
- US: `ATVPDKIKX0DER`
- CA: `A2EUQ1WTGCTBG2`
- UK: `A1F83G8C2ARO7P`
- DE: `A1PA6795UKMFR9`
- FR: `A13V1IB3VIYZZH`
- IT: `APJ6JRA9NG5V4`
- ES: `A1RKKUPIHCS9HS`
- JP: `A1VC38T7YXB528`

## 📚 Additional Resources

- [Amazon SP-API Documentation](https://developer-docs.amazon.com/sp-api/)
- [AWS Signature V4 Signing Process](https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html)
- [LWA Documentation](https://developer.amazon.com/docs/login-with-amazon/documentation-overview.html)

## 🐛 Troubleshooting

### Issue: "403 Forbidden" Error
**Solution:** Verify your AWS IAM user has the correct SP-API permissions:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:*:*:*"
    }
  ]
}
```

### Issue: "Invalid AWS credentials"
**Solution:** 
1. Verify AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are correct
2. Ensure they're from an IAM user (not root account)
3. Check the AWS region matches your SP-API app registration

### Issue: "LWA token error: 400"
**Solution:**
1. Verify your LWA credentials are correct
2. Ensure the refresh token hasn't expired
3. Check that client_id and client_secret match your SP-API app

## 📄 License

This code is provided as-is for integration with Amazon SP-API. Follow Amazon's SP-API terms of service.

## 🤝 Support

For issues with:
- **This code**: Check the troubleshooting section above
- **SP-API setup**: Visit [Amazon Seller Central Developer Console](https://sellercentral.amazon.com/apps/manage)
- **AWS credentials**: Visit [AWS IAM Console](https://console.aws.amazon.com/iam/)
