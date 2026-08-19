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
        versionCode = 4
        versionName = "0.4.0"
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
        getByName("test") {
            kotlin.srcDirs("src/test/kotlin")
        }
    }

}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    // WebMessageCompat/WebViewCompat (ArrayBuffer WebMessageChannel bridging to the USB serial bridge).
    implementation("androidx.webkit:webkit:1.11.0")
    // Multi-chipset (FTDI/CP210x/CH340/PL2303/CDC-ACM) USB-serial driver.
    implementation("com.github.mik3y:usb-serial-for-android:3.4.3")

    testImplementation("junit:junit:4.13.2")
    testImplementation("io.mockk:mockk:1.13.13")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
}

// Embed the built air-webapp PWA bundle as Android assets so MainActivity
// can serve it over http://127.0.0.1:<port> inside the WebView. See ../README.md.
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
