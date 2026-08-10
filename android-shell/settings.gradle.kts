pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // usb-serial-for-android (Spike 4) is only published on JitPack, not Maven Central.
        maven(url = "https://jitpack.io")
    }
}

rootProject.name = "android-shell"
include(":app")
