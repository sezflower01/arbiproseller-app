Imports System
Imports System.Collections.Generic
Imports System.Linq
Imports System.Net.Http
Imports System.Security.Cryptography
Imports System.Text
Imports System.Text.Json
Imports System.Text.Json.Serialization
Imports System.Threading.Tasks
Imports System.Web

''' <summary>
''' Amazon Selling Partner API (SP-API) Integration for Visual Basic .NET
''' Includes AWS SigV4 signing, LWA token retrieval, product lookup, pricing, and ROI calculation
''' </summary>
Public Class AmazonSPAPIClient
    ' Configuration - Set these from your Supabase secrets or app.config
    Private ReadOnly AwsAccessKeyId As String
    Private ReadOnly AwsSecretAccessKey As String
    Private ReadOnly AwsRegion As String
    Private ReadOnly LwaClientId As String
    Private ReadOnly LwaClientSecret As String
    Private ReadOnly LwaRefreshToken As String
    Private ReadOnly MarketplaceId As String = "ATVPDKIKX0DER" ' US marketplace

    Private ReadOnly httpClient As New HttpClient()

    ''' <summary>
    ''' Constructor - Initialize with your credentials
    ''' </summary>
    Public Sub New(awsAccessKey As String, awsSecretKey As String, 
                   lwaClientId As String, lwaClientSecret As String, 
                   lwaRefreshToken As String, Optional region As String = "us-east-1")
        Me.AwsAccessKeyId = awsAccessKey
        Me.AwsSecretAccessKey = awsSecretKey
        Me.AwsRegion = region
        Me.LwaClientId = lwaClientId
        Me.LwaClientSecret = lwaClientSecret
        Me.LwaRefreshToken = lwaRefreshToken
    End Sub

#Region "Data Models"

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

    Public Class ProductData
        Public Property Asin As String
        Public Property Title As String
        Public Property ImageUrl As String
        Public Property Price As Decimal
        Public Property PriceSource As String
        Public Property Link As String
        Public Property Fees As ActualFees
    End Class

    Public Class ActualFees
        Public Property ReferralFee As Decimal
        Public Property FbaFee As Decimal
        Public Property VariableClosingFee As Decimal
        Public Property OtherFees As Decimal
    End Class

    Public Class RoiResult
        Public Property Asin As String
        Public Property Title As String
        Public Property ImageUrl As String
        Public Property Price As Decimal
        Public Property PriceSource As String
        Public Property Link As String
        Public Property Calculation As FeeBreakdown
    End Class

#End Region

#Region "ROI Calculation"

    ''' <summary>
    ''' Calculate ROI and fees based on Amazon price and buy cost
    ''' </summary>
    Public Function CalculateRoi(amzPrice As Decimal, buyCost As Decimal, 
                                 Optional actualFees As ActualFees = Nothing) As FeeBreakdown
        Dim referralFee As Decimal = If(actualFees?.ReferralFee, amzPrice * 0.15D)
        Dim fbaFee As Decimal = If(actualFees?.FbaFee, 3.22D)
        Dim variableClosingFee As Decimal = If(actualFees?.VariableClosingFee, 0D)
        Dim otherFees As Decimal = If(actualFees?.OtherFees, 0D)
        
        Dim totalFees As Decimal = referralFee + fbaFee + variableClosingFee + otherFees
        Dim profit As Decimal = amzPrice - buyCost - totalFees
        Dim roi As Decimal = If(buyCost > 0, (profit / buyCost) * 100, 0)
        Dim margin As Decimal = If(amzPrice > 0, (profit / amzPrice) * 100, 0)

        Return New FeeBreakdown With {
            .ReferralFee = Math.Round(referralFee, 2),
            .FbaFee = Math.Round(fbaFee, 2),
            .VariableClosingFee = Math.Round(variableClosingFee, 2),
            .OtherFees = Math.Round(otherFees, 2),
            .TotalFees = Math.Round(totalFees, 2),
            .Profit = Math.Round(profit, 2),
            .Roi = Math.Round(roi, 2),
            .Margin = Math.Round(margin, 2)
        }
    End Function

#End Region

#Region "AWS Signature V4 Signing"

    ''' <summary>
    ''' Sign HTTP request using AWS Signature Version 4
    ''' </summary>
    Private Async Function SignRequestAsync(method As String, url As String, 
                                           body As String, accessToken As String) As Task(Of Dictionary(Of String, String))
        Dim uri As New Uri(url)
        Dim host As String = uri.Host
        Dim path As String = uri.PathAndQuery
        
        Dim now As DateTime = DateTime.UtcNow
        Dim amzDate As String = now.ToString("yyyyMMddTHHmmssZ")
        Dim dateStamp As String = now.ToString("yyyyMMdd")
        
        ' Create canonical request
        Dim canonicalHeaders As String = $"host:{host}" & vbLf & 
                                        $"x-amz-access-token:{accessToken}" & vbLf & 
                                        $"x-amz-date:{amzDate}" & vbLf
        Dim signedHeaders As String = "host;x-amz-access-token;x-amz-date"
        
        Dim payloadHash As String = ComputeSHA256Hash(body)
        Dim canonicalRequest As String = $"{method}" & vbLf & 
                                        $"{path}" & vbLf & vbLf & 
                                        $"{canonicalHeaders}" & vbLf & 
                                        $"{signedHeaders}" & vbLf & 
                                        $"{payloadHash}"
        
        ' Create string to sign
        Dim algorithm As String = "AWS4-HMAC-SHA256"
        Dim credentialScope As String = $"{dateStamp}/{AwsRegion}/execute-api/aws4_request"
        Dim canonicalRequestHash As String = ComputeSHA256Hash(canonicalRequest)
        Dim stringToSign As String = $"{algorithm}" & vbLf & 
                                    $"{amzDate}" & vbLf & 
                                    $"{credentialScope}" & vbLf & 
                                    $"{canonicalRequestHash}"
        
        ' Calculate signature
        Dim signingKey As Byte() = GetSignatureKey(AwsSecretAccessKey, dateStamp, AwsRegion, "execute-api")
        Dim signature As String = ByteArrayToHexString(ComputeHMACSHA256(stringToSign, signingKey))
        
        Dim authorizationHeader As String = $"{algorithm} Credential={AwsAccessKeyId}/{credentialScope}, SignedHeaders={signedHeaders}, Signature={signature}"
        
        Return New Dictionary(Of String, String) From {
            {"Authorization", authorizationHeader},
            {"x-amz-access-token", accessToken},
            {"x-amz-date", amzDate},
            {"Content-Type", "application/json"}
        }
    End Function

    Private Function GetSignatureKey(key As String, dateStamp As String, 
                                    regionName As String, serviceName As String) As Byte()
        Dim kDate As Byte() = ComputeHMACSHA256(dateStamp, Encoding.UTF8.GetBytes("AWS4" & key))
        Dim kRegion As Byte() = ComputeHMACSHA256(regionName, kDate)
        Dim kService As Byte() = ComputeHMACSHA256(serviceName, kRegion)
        Dim kSigning As Byte() = ComputeHMACSHA256("aws4_request", kService)
        Return kSigning
    End Function

    Private Function ComputeHMACSHA256(data As String, key As Byte()) As Byte()
        Using hmac As New HMACSHA256(key)
            Return hmac.ComputeHash(Encoding.UTF8.GetBytes(data))
        End Using
    End Function

    Private Function ComputeSHA256Hash(text As String) As String
        Using sha256 As SHA256 = SHA256.Create()
            Dim bytes As Byte() = sha256.ComputeHash(Encoding.UTF8.GetBytes(text))
            Return ByteArrayToHexString(bytes)
        End Using
    End Function

    Private Function ByteArrayToHexString(bytes As Byte()) As String
        Return String.Concat(bytes.Select(Function(b) b.ToString("x2")))
    End Function

#End Region

#Region "LWA Token Authentication"

    ''' <summary>
    ''' Get Login with Amazon (LWA) access token using refresh token
    ''' </summary>
    Private Async Function GetLWAAccessTokenAsync() As Task(Of String)
        If String.IsNullOrEmpty(LwaClientId) OrElse String.IsNullOrEmpty(LwaClientSecret) OrElse String.IsNullOrEmpty(LwaRefreshToken) Then
            Throw New Exception("Missing SP-API credentials (LWA Client ID, Secret, or Refresh Token)")
        End If

        Dim tokenUrl As String = "https://api.amazon.com/auth/o2/token"
        Dim content As New FormUrlEncodedContent(New Dictionary(Of String, String) From {
            {"grant_type", "refresh_token"},
            {"refresh_token", LwaRefreshToken},
            {"client_id", LwaClientId},
            {"client_secret", LwaClientSecret}
        })

        Dim response As HttpResponseMessage = Await httpClient.PostAsync(tokenUrl, content)
        
        If Not response.IsSuccessStatusCode Then
            Throw New Exception($"LWA token error: {response.StatusCode}")
        End If

        Dim jsonResponse As String = Await response.Content.ReadAsStringAsync()
        Dim tokenData As JsonDocument = JsonDocument.Parse(jsonResponse)
        Return tokenData.RootElement.GetProperty("access_token").GetString()
    End Function

#End Region

#Region "SP-API Product Methods"

    ''' <summary>
    ''' Get product fees estimate from Amazon SP-API
    ''' </summary>
    Private Async Function GetProductFeesAsync(asin As String, price As Decimal, 
                                              accessToken As String) As Task(Of ActualFees)
        Dim feesUrl As String = $"https://sellingpartnerapi-na.amazon.com/products/fees/v0/items/{asin}/feesEstimate"
        
        Dim feesBody As String = JsonSerializer.Serialize(New With {
            .FeesEstimateRequest = New With {
                .MarketplaceId = MarketplaceId,
                .IsAmazonFulfilled = True,
                .PriceToEstimateFees = New With {
                    .ListingPrice = New With {
                        .CurrencyCode = "USD",
                        .Amount = price
                    }
                },
                .Identifier = asin
            }
        })

        Dim headers As Dictionary(Of String, String) = Await SignRequestAsync("POST", feesUrl, feesBody, accessToken)
        
        Dim request As New HttpRequestMessage(HttpMethod.Post, feesUrl) With {
            .Content = New StringContent(feesBody, Encoding.UTF8, "application/json")
        }
        For Each header In headers
            request.Headers.TryAddWithoutValidation(header.Key, header.Value)
        Next

        Dim response As HttpResponseMessage = Await httpClient.SendAsync(request)
        
        If Not response.IsSuccessStatusCode Then
            Dim errorText As String = Await response.Content.ReadAsStringAsync()
            Console.WriteLine($"Fees API error {response.StatusCode}: {errorText}")
            Throw New Exception($"SP-API Fees calculation failed: {response.StatusCode} - Invalid AWS credentials")
        End If

        Dim feesJson As String = Await response.Content.ReadAsStringAsync()
        Dim feesData As JsonDocument = JsonDocument.Parse(feesJson)
        
        Console.WriteLine($"Amazon Fees API full response: {feesJson}")
        
        Dim feeDetails = feesData.RootElement.GetProperty("payload").GetProperty("FeesEstimateResult").GetProperty("FeesEstimate").GetProperty("FeeDetailList")
        
        Dim referralFee As Decimal = 0
        Dim fbaFee As Decimal = 0
        Dim variableClosingFee As Decimal = 0
        Dim otherFees As Decimal = 0

        For Each fee In feeDetails.EnumerateArray()
            Dim feeType As String = fee.GetProperty("FeeType").GetString()
            Dim amount As Decimal = Decimal.Parse(fee.GetProperty("FeeAmount").GetProperty("Amount").GetString())
            
            Console.WriteLine($"Fee: {feeType} = ${amount}")
            
            Select Case feeType
                Case "ReferralFee"
                    referralFee = amount
                Case "FBAFees"
                    fbaFee = amount
                Case "VariableClosingFee"
                    variableClosingFee = amount
                Case Else
                    otherFees += amount
            End Select
        Next

        Console.WriteLine($"Total extracted fees - Referral: ${referralFee}, FBA: ${fbaFee}, Variable Closing: ${variableClosingFee}, Other: ${otherFees}")
        
        Return New ActualFees With {
            .ReferralFee = referralFee,
            .FbaFee = fbaFee,
            .VariableClosingFee = variableClosingFee,
            .OtherFees = otherFees
        }
    End Function

    ''' <summary>
    ''' Enrich ASIN with SP-API data (product info, pricing, fees)
    ''' </summary>
    Private Async Function EnrichAsinWithSPAPIAsync(asin As String) As Task(Of ProductData)
        Dim accessToken As String = Await GetLWAAccessTokenAsync()
        
        ' Get product catalog info (title, image)
        Dim catalogUrl As String = $"https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/{asin}?marketplaceIds={MarketplaceId}&includedData=summaries,images"
        Dim catalogHeaders As Dictionary(Of String, String) = Await SignRequestAsync("GET", catalogUrl, "", accessToken)
        
        Dim catalogRequest As New HttpRequestMessage(HttpMethod.Get, catalogUrl)
        For Each header In catalogHeaders
            catalogRequest.Headers.TryAddWithoutValidation(header.Key, header.Value)
        Next

        Dim catalogResponse As HttpResponseMessage = Await httpClient.SendAsync(catalogRequest)
        
        If Not catalogResponse.IsSuccessStatusCode Then
            Dim errorText As String = Await catalogResponse.Content.ReadAsStringAsync()
            Console.WriteLine($"Catalog API error {catalogResponse.StatusCode}: {errorText}")
            Throw New Exception($"SP-API authentication failed: {catalogResponse.StatusCode} - Invalid AWS credentials or LWA token")
        End If

        Dim catalogJson As String = Await catalogResponse.Content.ReadAsStringAsync()
        Dim catalogData As JsonDocument = JsonDocument.Parse(catalogJson)
        
        Dim title As String = ""
        Dim imageUrl As String = "https://images-na.ssl-images-amazon.com/images/I/41qN3q3KPUL.jpg"
        
        If catalogData.RootElement.TryGetProperty("summaries", Nothing) Then
            Dim summaries = catalogData.RootElement.GetProperty("summaries")
            If summaries.GetArrayLength() > 0 Then
                title = summaries(0).GetProperty("itemName").GetString()
            End If
        End If
        
        If catalogData.RootElement.TryGetProperty("images", Nothing) Then
            Dim images = catalogData.RootElement.GetProperty("images")
            If images.GetArrayLength() > 0 Then
                Dim imageList = images(0).GetProperty("images")
                If imageList.GetArrayLength() > 0 Then
                    imageUrl = imageList(0).GetProperty("link").GetString()
                End If
            End If
        End If
        
        Dim link As String = $"https://www.amazon.com/dp/{asin}"
        
        ' Get pricing info - Try Competitive Pricing API
        Dim price As Decimal = 0
        Dim priceSource As String = "unavailable"
        
        Dim competitivePricingUrl As String = $"https://sellingpartnerapi-na.amazon.com/products/pricing/v0/price?MarketplaceId={MarketplaceId}&Asins={asin}&ItemType=Asin"
        Dim compPricingHeaders As Dictionary(Of String, String) = Await SignRequestAsync("GET", competitivePricingUrl, "", accessToken)
        
        Dim compPricingRequest As New HttpRequestMessage(HttpMethod.Get, competitivePricingUrl)
        For Each header In compPricingHeaders
            compPricingRequest.Headers.TryAddWithoutValidation(header.Key, header.Value)
        Next

        Dim compPricingResponse As HttpResponseMessage = Await httpClient.SendAsync(compPricingRequest)
        
        If compPricingResponse.IsSuccessStatusCode Then
            Dim compPricingJson As String = Await compPricingResponse.Content.ReadAsStringAsync()
            Dim compPricingData As JsonDocument = JsonDocument.Parse(compPricingJson)
            
            Console.WriteLine($"Competitive Pricing API response: {compPricingJson}")
            
            ' Extract competitive prices
            If compPricingData.RootElement.TryGetProperty("payload", Nothing) Then
                Dim payload = compPricingData.RootElement.GetProperty("payload")
                If payload.GetArrayLength() > 0 Then
                    Dim priceInfo = payload(0)
                    If priceInfo.TryGetProperty("Product", Nothing) Then
                        Dim product = priceInfo.GetProperty("Product")
                        If product.TryGetProperty("CompetitivePricing", Nothing) Then
                            Dim competitivePricing = product.GetProperty("CompetitivePricing")
                            If competitivePricing.TryGetProperty("CompetitivePrices", Nothing) Then
                                For Each cp In competitivePricing.GetProperty("CompetitivePrices").EnumerateArray()
                                    If cp.TryGetProperty("Price", Nothing) Then
                                        Dim priceObj = cp.GetProperty("Price")
                                        If priceObj.TryGetProperty("LandedPrice", Nothing) Then
                                            Dim landedPrice = priceObj.GetProperty("LandedPrice")
                                            If landedPrice.TryGetProperty("Amount", Nothing) Then
                                                price = Decimal.Parse(landedPrice.GetProperty("Amount").GetString())
                                                priceSource = "competitive_pricing"
                                                Console.WriteLine($"Using Competitive Pricing API price: ${price}")
                                                Exit For
                                            End If
                                        End If
                                    End If
                                Next
                            End If
                        End If
                    End If
                End If
            End If
        Else
            Dim errorText As String = Await compPricingResponse.Content.ReadAsStringAsync()
            Console.WriteLine($"Competitive Pricing API failed: {compPricingResponse.StatusCode} {errorText}")
            Throw New Exception($"SP-API Competitive Pricing failed: {compPricingResponse.StatusCode} - Invalid AWS credentials")
        End If
        
        ' If no price yet, try GetItemOffers API
        If price = 0 Then
            Dim offersUrl As String = $"https://sellingpartnerapi-na.amazon.com/products/pricing/v0/items/{asin}/offers?MarketplaceId={MarketplaceId}&ItemCondition=New"
            Dim offersHeaders As Dictionary(Of String, String) = Await SignRequestAsync("GET", offersUrl, "", accessToken)
            
            Dim offersRequest As New HttpRequestMessage(HttpMethod.Get, offersUrl)
            For Each header In offersHeaders
                offersRequest.Headers.TryAddWithoutValidation(header.Key, header.Value)
            Next

            Dim offersResponse As HttpResponseMessage = Await httpClient.SendAsync(offersRequest)
            
            If offersResponse.IsSuccessStatusCode Then
                Dim offersJson As String = Await offersResponse.Content.ReadAsStringAsync()
                Dim offersData As JsonDocument = JsonDocument.Parse(offersJson)
                
                Console.WriteLine($"Item Offers API response: {offersJson}")
                
                ' Try Buy Box price
                If offersData.RootElement.TryGetProperty("payload", Nothing) Then
                    Dim payload = offersData.RootElement.GetProperty("payload")
                    If payload.TryGetProperty("Summary", Nothing) Then
                        Dim summary = payload.GetProperty("Summary")
                        If summary.TryGetProperty("BuyBoxPrices", Nothing) Then
                            Dim buyBoxPrices = summary.GetProperty("BuyBoxPrices")
                            If buyBoxPrices.GetArrayLength() > 0 Then
                                Dim buyBoxPrice = buyBoxPrices(0)
                                If buyBoxPrice.TryGetProperty("LandedPrice", Nothing) Then
                                    Dim landedPrice = buyBoxPrice.GetProperty("LandedPrice")
                                    If landedPrice.TryGetProperty("Amount", Nothing) Then
                                        price = Decimal.Parse(landedPrice.GetProperty("Amount").GetString())
                                        priceSource = "buybox"
                                        Console.WriteLine($"Using Buy Box price: ${price}")
                                    End If
                                End If
                            End If
                        End If
                    End If
                End If
            Else
                Dim errorText As String = Await offersResponse.Content.ReadAsStringAsync()
                Console.WriteLine($"Item Offers API failed: {offersResponse.StatusCode} {errorText}")
                Throw New Exception($"SP-API Item Offers failed: {offersResponse.StatusCode} - Invalid AWS credentials")
            End If
        End If
        
        ' Get actual fees from Amazon
        Dim fees As ActualFees = Nothing
        If price > 0 Then
            fees = Await GetProductFeesAsync(asin, price, accessToken)
        End If

        Return New ProductData With {
            .Asin = asin,
            .Title = title,
            .Price = price,
            .ImageUrl = imageUrl,
            .Link = link,
            .Fees = fees,
            .PriceSource = priceSource
        }
    End Function

#End Region

#Region "Public API Methods"

    ''' <summary>
    ''' Calculate ROI for a given ASIN with optional buy cost
    ''' </summary>
    Public Async Function CalculateRoiForAsinAsync(asin As String, Optional buyCost As Decimal? = Nothing) As Task(Of RoiResult)
        ' Fetch product data from Amazon SP-API
        Dim productData As ProductData = Await EnrichAsinWithSPAPIAsync(asin)
        
        ' Calculate ROI if cost is provided
        Dim calculation As FeeBreakdown = Nothing
        If buyCost.HasValue AndAlso productData.Price > 0 Then
            calculation = CalculateRoi(productData.Price, buyCost.Value, productData.Fees)
        End If

        Return New RoiResult With {
            .Asin = asin,
            .Title = productData.Title,
            .ImageUrl = productData.ImageUrl,
            .Price = productData.Price,
            .PriceSource = productData.PriceSource,
            .Link = productData.Link,
            .Calculation = calculation
        }
    End Function

    ''' <summary>
    ''' Get product information without ROI calculation
    ''' </summary>
    Public Async Function GetProductInfoAsync(asin As String) As Task(Of ProductData)
        Return Await EnrichAsinWithSPAPIAsync(asin)
    End Function

#End Region

End Class

' ======================================
' USAGE EXAMPLE
' ======================================
Module Program
    Sub Main()
        ' Example usage
        ExampleUsage().Wait()
    End Sub

    Async Function ExampleUsage() As Task
        Try
            ' Initialize the client with your credentials
            Dim client As New AmazonSPAPIClient(
                awsAccessKey:="YOUR_AWS_ACCESS_KEY_ID",
                awsSecretKey:="YOUR_AWS_SECRET_ACCESS_KEY",
                lwaClientId:="YOUR_SPAPI_LWA_CLIENT_ID",
                lwaClientSecret:="YOUR_SPAPI_LWA_CLIENT_SECRET",
                lwaRefreshToken:="YOUR_SPAPI_REFRESH_TOKEN",
                region:="us-east-1"
            )

            ' Example 1: Calculate ROI for an ASIN with buy cost
            Console.WriteLine("Example 1: Calculate ROI")
            Dim result As AmazonSPAPIClient.RoiResult = Await client.CalculateRoiForAsinAsync("B019PXKQK6", 12D)
            
            Console.WriteLine($"ASIN: {result.Asin}")
            Console.WriteLine($"Title: {result.Title}")
            Console.WriteLine($"Price: ${result.Price}")
            Console.WriteLine($"Image: {result.ImageUrl}")
            
            If result.Calculation IsNot Nothing Then
                Console.WriteLine(vbLf & "ROI Calculation:")
                Console.WriteLine($"  Referral Fee: ${result.Calculation.ReferralFee}")
                Console.WriteLine($"  FBA Fee: ${result.Calculation.FbaFee}")
                Console.WriteLine($"  Total Fees: ${result.Calculation.TotalFees}")
                Console.WriteLine($"  Profit: ${result.Calculation.Profit}")
                Console.WriteLine($"  ROI: {result.Calculation.Roi}%")
                Console.WriteLine($"  Margin: {result.Calculation.Margin}%")
            End If

            Console.WriteLine(vbLf & "========================================" & vbLf)

            ' Example 2: Get product info only (no ROI calculation)
            Console.WriteLine("Example 2: Get Product Info Only")
            Dim productInfo As AmazonSPAPIClient.ProductData = Await client.GetProductInfoAsync("B019PXKQK6")
            
            Console.WriteLine($"ASIN: {productInfo.Asin}")
            Console.WriteLine($"Title: {productInfo.Title}")
            Console.WriteLine($"Price: ${productInfo.Price}")
            Console.WriteLine($"Price Source: {productInfo.PriceSource}")

        Catch ex As Exception
            Console.WriteLine($"Error: {ex.Message}")
            Console.WriteLine($"Stack Trace: {ex.StackTrace}")
        End Try
    End Function
End Module
