$ports = '80,443,445,8080'
Write-Host "direct: [$ports] type=$($ports.GetType().Name) count=$($ports.Count)"

$obj = @{ scope = @{ ports = $ports } }
$json = $obj | ConvertTo-Json -Depth 5
Write-Host "json: $json"

# 问题定位：ConvertTo-Json 是否把含逗号字符串拆成数组
$arr = $json | ConvertFrom-Json
Write-Host "roundtrip type: $($arr.scope.ports.GetType().Name)"
Write-Host "roundtrip value: $($arr.scope.ports)"
