#!/usr/bin/env pwsh

param (
    [string]$match
)

if (-not $match) {
    Write-Host "Please provide a match"
    exit 1
}

if (-not (Test-Path "matches/$match.json")) {
    Write-Host "Match $match not found"
    exit 1
}

Copy-Item -Path "matches/$match.json" -Destination "match.json"
Write-Host "Beginning match $match"
npm start
