import org.gradle.api.tasks.PathSensitivity

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// A stable signing key means every build can install over the previous one.
// Without it Gradle falls back to a debug key that CI regenerates per run, which
// makes Android reject the update with "App not installed".
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")
val keystorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val keystoreAlias: String? = System.getenv("ANDROID_KEY_ALIAS")
val hasSigningKey = !keystorePath.isNullOrBlank() && file(keystorePath).exists()

android {
    namespace = "us.i3u.hermesstudio"
    compileSdk = 34

    defaultConfig {
        applicationId = "us.i3u.hermesstudio"
        minSdk = 26
        targetSdk = 34
        versionCode = 17
        versionName = "0.12.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasSigningKey) {
            create("shared") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = keystoreAlias
                keyPassword = keystorePassword
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            if (hasSigningKey) signingConfig = signingConfigs.getByName("shared")
        }
        release {
            isMinifyEnabled = false
            signingConfig = if (hasSigningKey) {
                signingConfigs.getByName("shared")
            } else {
                signingConfigs.getByName("debug")
            }
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
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

// TranslationsTest reads the resource files straight off disk, so Gradle has to
// be told they are inputs — otherwise a broken translation looks up to date.
tasks.withType<Test>().configureEach {
    inputs.dir("src/main/res").withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file("src/main/java/us/i3u/hermesstudio/Locales.kt")
    testLogging { events("failed") }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.2")
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Talks to the server's /chat-run and /group-chat namespaces, so replies
    // stream in as they are written instead of arriving all at once.
    implementation("io.socket:socket.io-client:2.1.2") {
        exclude(group = "org.json", module = "json")
    }
    // Draws the Multiavatar SVG Studio generates for a profile without a picture.
    implementation("com.caverock:androidsvg-aar:1.4")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
}
