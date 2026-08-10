plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "link.dronelink.androidshell"
    compileSdk = 34

    defaultConfig {
        applicationId = "link.dronelink.androidshell"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "0.3.0-spike3"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets {
        getByName("main") {
            kotlin.srcDirs("src/main/kotlin")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}

// Spike 1: embed the built air-webapp PWA bundle as Android assets so
// MainActivity can serve it over http://127.0.0.1:<port> inside the WebView.
// See spikes/spike-1-webview-shell.md and ../README.md "Android (Phase 2.5)".
val webappDist = file("$rootDir/../apps/air-webapp/dist")
val webappAssets = file("src/main/assets/webapp")

tasks.register("cleanWebappAssets") {
    doLast {
        webappAssets.listFiles()?.forEach { existing ->
            if (existing.name != ".gitkeep") existing.deleteRecursively()
        }
    }
}

tasks.register<Copy>("copyWebapp") {
    dependsOn("cleanWebappAssets")
    doFirst {
        if (!webappDist.exists()) {
            throw GradleException(
                "apps/air-webapp/dist not found at $webappDist. Run " +
                    "`npm run build --workspace @dronelink/air-webapp` from the repo root first."
            )
        }
    }
    from(webappDist)
    into(webappAssets)
}

tasks.named("preBuild") {
    dependsOn("copyWebapp")
}
