import java.io.File

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "ai.webtunnel.mobile"
  compileSdk = 35

  defaultConfig {
    applicationId = "ai.webtunnel.mobile"
    minSdk = 26
    targetSdk = 35
    versionCode = 2
    versionName = "0.2.0"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
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
    viewBinding = true
    buildConfig = true
  }

  applicationVariants.all {
    val variant = this
    variant.outputs.all {
      val out = this as com.android.build.gradle.internal.api.BaseVariantOutputImpl
      out.outputFileName = "WebTunnel-Client-Android.apk"
    }
  }
}

tasks.register<Copy>("copyApkToRelease") {
  val variant = "release"
  from("$buildDir/outputs/apk/$variant/WebTunnel-Client-Android.apk")
  into(rootProject.file("../release"))
}

afterEvaluate {
  tasks.named("assembleRelease").configure {
    finalizedBy("copyApkToRelease")
  }
  tasks.named("assembleDebug").configure {
    doLast {
      val src = file("$buildDir/outputs/apk/debug/WebTunnel-Client-Android.apk")
      if (src.exists()) {
        val destDir = rootProject.file("../release")
        destDir.mkdirs()
        src.copyTo(File(destDir, "WebTunnel-Client-Android.apk"), overwrite = true)
      }
    }
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.constraintlayout:constraintlayout:2.1.4")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
  implementation("org.lz4:lz4-java:1.8.0")
  implementation("io.livekit:livekit-android:2.24.1")
}
