# Re-encode CC0 source images (assets-src/polyhaven) into public/assets/ph at a given JPEG quality.
# usage: powershell -File tools/pack-assets.ps1 [-Quality 80]
param([int]$Quality = 80)
Add-Type -AssemblyName System.Drawing
$src = Resolve-Path "assets-src/polyhaven"
$dst = Join-Path (Get-Location) "public/assets/ph"
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
Get-ChildItem -Recurse -File $src | ForEach-Object {
  $rel = $_.FullName.Substring($src.Path.Length + 1)
  $out = Join-Path $dst $rel
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  if ($_.Extension -eq '.jpg') {
    $img = [System.Drawing.Image]::FromFile($_.FullName)
    $img.Save($out, $codec, $ep); $img.Dispose()
  } else { Copy-Item $_.FullName $out -Force }
}
# glTF → single .json with the .bin embedded as a data: URI (artifact hosting serves .json, not .gltf/.bin)
Get-ChildItem -Recurse -File $dst -Filter *.gltf | ForEach-Object {
  $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
  foreach ($b in $j.buffers) {
    $binPath = Join-Path $_.DirectoryName $b.uri
    $b.uri = 'data:application/octet-stream;base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($binPath))
    Remove-Item $binPath
  }
  $out = [IO.Path]::ChangeExtension($_.FullName, '.json')
  [IO.File]::WriteAllText($out, ($j | ConvertTo-Json -Depth 64 -Compress))
  Remove-Item $_.FullName
}
# grass_medium_02: only its diffuse photo is used (blade atlas)
Remove-Item -ErrorAction SilentlyContinue (Join-Path $dst 'grass_medium_02/grass_medium_02_1k.json'), (Join-Path $dst 'grass_medium_02/textures/grass_medium_02_arm_1k.jpg'), (Join-Path $dst 'grass_medium_02/textures/grass_medium_02_nor_gl_1k.jpg')
"{0:N2} MB" -f ((Get-ChildItem -Recurse -File $dst | Measure-Object Length -Sum).Sum / 1MB)
