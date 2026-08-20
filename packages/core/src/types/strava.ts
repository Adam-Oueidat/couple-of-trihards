export interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix timestamp
  athlete_id: number;
  athlete_firstname: string;
  athlete_lastname: string;
  athlete_profile: string;
}

export type SportType =
  | "Run"
  | "Ride"
  | "Swim"
  | "VirtualRide"
  | "VirtualRun"
  | "Walk"
  | string;

export interface StravaActivity {
  id: number;
  name: string;
  sport_type: SportType;
  type: string;
  start_date: string; // ISO 8601
  start_date_local: string;
  distance: number; // meters
  moving_time: number; // seconds
  elapsed_time: number; // seconds
  total_elevation_gain: number; // meters
  average_speed: number; // m/s
  max_speed: number; // m/s
  average_heartrate?: number;
  max_heartrate?: number;
  suffer_score?: number;
  kilojoules?: number; // for rides
  average_watts?: number;
  weighted_average_watts?: number;
  trainer: boolean;
  manual: boolean;
}

export interface StravaAthlete {
  id: number;
  firstname: string;
  lastname: string;
  profile_medium: string;
  profile: string;
  city: string;
  country: string;
}

export interface Split {
  split: number;
  distance: number; // meters
  moving_time: number; // seconds
  elapsed_time: number;
  average_speed: number; // m/s
  average_heartrate?: number;
  elevation_difference: number;
}

export interface Lap {
  id: number;
  name: string;
  lap_index: number;
  distance: number; // meters
  moving_time: number; // seconds
  elapsed_time: number; // seconds
  average_speed: number; // m/s
  max_speed?: number; // m/s
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  average_watts?: number;
  total_elevation_gain?: number; // meters
  // Indices into the activity's stream arrays — slice streams per lap for
  // interval-level HR/pace/power analysis.
  start_index?: number;
  end_index?: number;
}

export interface BestEffort {
  name: string; // e.g. "1k", "5k", "10k"
  distance: number;
  moving_time: number;
}

export interface DetailedActivity extends StravaActivity {
  description?: string;
  calories?: number;
  device_name?: string;
  splits_metric?: Split[];
  laps?: Lap[];
  best_efforts?: BestEffort[];
  gear?: { name: string; distance: number };
}

export interface Stream {
  data: number[];
}

export interface StreamSet {
  time?: Stream;
  distance?: Stream;
  heartrate?: Stream;
  velocity_smooth?: Stream;
  altitude?: Stream;
  cadence?: Stream;
  watts?: Stream;
}

export interface HRZoneRange {
  min: number;
  max: number; // -1 means open-ended (Strava's convention for the top zone)
}

export interface AthleteZones {
  heart_rate?: { custom_zones: boolean; zones: HRZoneRange[] };
  power?: { zones: HRZoneRange[] };
}

export interface ActivityTotals {
  count: number;
  distance: number; // meters
  moving_time: number; // seconds
  elevation_gain: number; // meters
}

export interface AthleteStats {
  biggest_ride_distance: number;
  biggest_climb_elevation_gain: number;
  recent_ride_totals: ActivityTotals;
  recent_run_totals: ActivityTotals;
  recent_swim_totals: ActivityTotals;
  ytd_ride_totals: ActivityTotals;
  ytd_run_totals: ActivityTotals;
  ytd_swim_totals: ActivityTotals;
  all_ride_totals: ActivityTotals;
  all_run_totals: ActivityTotals;
  all_swim_totals: ActivityTotals;
}

export interface AthleteDetail extends StravaAthlete {
  weight?: number; // kg
  ftp?: number; // watts (cyclists only)
  measurement_preference?: string;
}

export type Discipline = "run" | "ride" | "swim" | "other";

export interface WeeklyVolume {
  weekStart: string; // ISO date string (Monday)
  run: number; // km
  ride: number; // km
  swim: number; // m
  runTime: number; // minutes
  rideTime: number; // minutes
  swimTime: number; // minutes
}
