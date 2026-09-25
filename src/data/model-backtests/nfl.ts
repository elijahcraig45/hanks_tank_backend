/**
 * Stored research backtest for NFL — GENERATED, do not edit by hand.
 *
 * Source: hanks_tank_ml research/models_page/export_backtests.py (branch
 * models/shadow-writers), which scores the per-game research frames named in each
 * window's `source`. Regenerate there and paste the JSON here.
 */
/* eslint-disable */
export const NFL_BACKTEST: any = 
{
 "sport": "nfl",
 "generated_at": "2026-09-25",
 "kind": "backtest",
 "windows": [
  {
   "key": "2017-24",
   "label": "Walk-forward 2017-2024",
   "n": 2202,
   "note": "Ties (home_won missing) dropped. Ridge and sim refit weekly on games before each week.",
   "source": "hanks_tank_ml research/football_2026_09/drive_sim (eval_sim.py), frozen config c_g chosen on 2010-16 before scoring",
   "block": "wk",
   "reference": "market",
   "models": [
    {
     "key": "market",
     "label": "Closing line (benchmark)",
     "n": 2202,
     "log_loss": {
      "value": 0.60862,
      "lo": 0.59456,
      "hi": 0.62182
     },
     "accuracy": {
      "value": 0.66621,
      "lo": 0.64591,
      "hi": 0.68566
     },
     "brier": {
      "value": 0.21035,
      "lo": 0.20401,
      "hi": 0.21639
     },
     "calibration": [
      {
       "p": 0.2591,
       "y": 0.1991,
       "n": 221,
       "y_lo": 0.1464,
       "y_hi": 0.2517
      },
      {
       "p": 0.3666,
       "y": 0.3394,
       "n": 221,
       "y_lo": 0.2769,
       "y_hi": 0.4018
      },
      {
       "p": 0.4141,
       "y": 0.3864,
       "n": 220,
       "y_lo": 0.322,
       "y_hi": 0.4507
      },
      {
       "p": 0.4689,
       "y": 0.4682,
       "n": 220,
       "y_lo": 0.4022,
       "y_hi": 0.5341
      },
      {
       "p": 0.5607,
       "y": 0.5318,
       "n": 220,
       "y_lo": 0.4659,
       "y_hi": 0.5978
      },
      {
       "p": 0.5909,
       "y": 0.5682,
       "n": 220,
       "y_lo": 0.5027,
       "y_hi": 0.6336
      },
      {
       "p": 0.6195,
       "y": 0.6682,
       "n": 220,
       "y_lo": 0.606,
       "y_hi": 0.7304
      },
      {
       "p": 0.6758,
       "y": 0.7091,
       "n": 220,
       "y_lo": 0.6491,
       "y_hi": 0.7691
      },
      {
       "p": 0.7209,
       "y": 0.7364,
       "n": 220,
       "y_lo": 0.6781,
       "y_hi": 0.7946
      },
      {
       "p": 0.8194,
       "y": 0.8773,
       "n": 220,
       "y_lo": 0.8339,
       "y_hi": 0.9206
      }
     ],
     "spread_mae": {
      "value": 9.89646,
      "lo": 9.56335,
      "hi": 10.26399
     },
     "total_mae": {
      "value": 10.53292,
      "lo": 10.24497,
      "hi": 10.82927
     }
    },
    {
     "key": "ridge",
     "label": "Margin ridge",
     "n": 2202,
     "log_loss": {
      "value": 0.63423,
      "lo": 0.61997,
      "hi": 0.64835
     },
     "accuracy": {
      "value": 0.63806,
      "lo": 0.61837,
      "hi": 0.65681
     },
     "brier": {
      "value": 0.22173,
      "lo": 0.21529,
      "hi": 0.22811
     },
     "calibration": [
      {
       "p": 0.254,
       "y": 0.2986,
       "n": 221,
       "y_lo": 0.2383,
       "y_hi": 0.359
      },
      {
       "p": 0.3698,
       "y": 0.3348,
       "n": 221,
       "y_lo": 0.2726,
       "y_hi": 0.3971
      },
      {
       "p": 0.4312,
       "y": 0.4273,
       "n": 220,
       "y_lo": 0.3619,
       "y_hi": 0.4926
      },
      {
       "p": 0.4868,
       "y": 0.4636,
       "n": 220,
       "y_lo": 0.3977,
       "y_hi": 0.5295
      },
      {
       "p": 0.5343,
       "y": 0.4818,
       "n": 220,
       "y_lo": 0.4158,
       "y_hi": 0.5478
      },
      {
       "p": 0.5804,
       "y": 0.5818,
       "n": 220,
       "y_lo": 0.5166,
       "y_hi": 0.647
      },
      {
       "p": 0.6223,
       "y": 0.6773,
       "n": 220,
       "y_lo": 0.6155,
       "y_hi": 0.7391
      },
      {
       "p": 0.6728,
       "y": 0.6909,
       "n": 220,
       "y_lo": 0.6298,
       "y_hi": 0.752
      },
      {
       "p": 0.7289,
       "y": 0.7364,
       "n": 220,
       "y_lo": 0.6781,
       "y_hi": 0.7946
      },
      {
       "p": 0.8189,
       "y": 0.7909,
       "n": 220,
       "y_lo": 0.7372,
       "y_hi": 0.8446
      }
     ],
     "spread_mae": {
      "value": 10.25295,
      "lo": 9.91087,
      "hi": 10.61551
     }
    },
    {
     "key": "drive_sim",
     "label": "Drive simulator (calibrated)",
     "n": 2202,
     "log_loss": {
      "value": 0.63314,
      "lo": 0.61785,
      "hi": 0.64766
     },
     "accuracy": {
      "value": 0.63851,
      "lo": 0.61896,
      "hi": 0.65824
     },
     "brier": {
      "value": 0.22102,
      "lo": 0.21429,
      "hi": 0.22755
     },
     "calibration": [
      {
       "p": 0.2469,
       "y": 0.276,
       "n": 221,
       "y_lo": 0.2171,
       "y_hi": 0.335
      },
      {
       "p": 0.3606,
       "y": 0.3213,
       "n": 221,
       "y_lo": 0.2597,
       "y_hi": 0.3828
      },
      {
       "p": 0.4306,
       "y": 0.4091,
       "n": 220,
       "y_lo": 0.3441,
       "y_hi": 0.4741
      },
      {
       "p": 0.4885,
       "y": 0.5227,
       "n": 220,
       "y_lo": 0.4567,
       "y_hi": 0.5887
      },
      {
       "p": 0.5387,
       "y": 0.4773,
       "n": 220,
       "y_lo": 0.4113,
       "y_hi": 0.5433
      },
      {
       "p": 0.5837,
       "y": 0.5773,
       "n": 220,
       "y_lo": 0.512,
       "y_hi": 0.6426
      },
      {
       "p": 0.6313,
       "y": 0.6818,
       "n": 220,
       "y_lo": 0.6203,
       "y_hi": 0.7434
      },
      {
       "p": 0.6811,
       "y": 0.7182,
       "n": 220,
       "y_lo": 0.6587,
       "y_hi": 0.7776
      },
      {
       "p": 0.7414,
       "y": 0.7091,
       "n": 220,
       "y_lo": 0.6491,
       "y_hi": 0.7691
      },
      {
       "p": 0.8255,
       "y": 0.7909,
       "n": 220,
       "y_lo": 0.7372,
       "y_hi": 0.8446
      }
     ],
     "spread_mae": {
      "value": 10.30486,
      "lo": 9.96195,
      "hi": 10.67177
     },
     "total_mae": {
      "value": 10.82475,
      "lo": 10.51378,
      "hi": 11.13887
     }
    }
   ],
   "deltas": [
    {
     "model": "ridge",
     "reference": "market",
     "log_loss_gain": {
      "value": -0.02561,
      "lo": -0.03317,
      "hi": -0.0184
     },
     "p_better": 0.0
    },
    {
     "model": "drive_sim",
     "reference": "market",
     "log_loss_gain": {
      "value": -0.02452,
      "lo": -0.03265,
      "hi": -0.01634
     },
     "p_better": 0.0
    }
   ]
  },
  {
   "key": "2025",
   "label": "Holdout 2025",
   "n": 284,
   "note": "Scored once, after the config was frozen.",
   "source": "hanks_tank_ml research/football_2026_09/drive_sim (eval_sim.py), frozen config c_g chosen on 2010-16 before scoring",
   "block": "wk",
   "reference": "market",
   "models": [
    {
     "key": "market",
     "label": "Closing line (benchmark)",
     "n": 284,
     "log_loss": {
      "value": 0.60933,
      "lo": 0.58113,
      "hi": 0.64137
     },
     "accuracy": {
      "value": 0.65845,
      "lo": 0.60464,
      "hi": 0.71004
     },
     "brier": {
      "value": 0.21156,
      "lo": 0.19844,
      "hi": 0.22636
     },
     "calibration": [
      {
       "p": 0.2697,
       "y": 0.1875,
       "n": 32,
       "y_lo": 0.0523,
       "y_hi": 0.3227
      },
      {
       "p": 0.3676,
       "y": 0.4062,
       "n": 32,
       "y_lo": 0.2361,
       "y_hi": 0.5764
      },
      {
       "p": 0.4149,
       "y": 0.4062,
       "n": 32,
       "y_lo": 0.2361,
       "y_hi": 0.5764
      },
      {
       "p": 0.4732,
       "y": 0.4688,
       "n": 32,
       "y_lo": 0.2958,
       "y_hi": 0.6417
      },
      {
       "p": 0.5646,
       "y": 0.5625,
       "n": 32,
       "y_lo": 0.3906,
       "y_hi": 0.7344
      },
      {
       "p": 0.5971,
       "y": 0.5806,
       "n": 31,
       "y_lo": 0.4069,
       "y_hi": 0.7544
      },
      {
       "p": 0.6492,
       "y": 0.5806,
       "n": 31,
       "y_lo": 0.4069,
       "y_hi": 0.7544
      },
      {
       "p": 0.7051,
       "y": 0.7419,
       "n": 31,
       "y_lo": 0.5879,
       "y_hi": 0.896
      },
      {
       "p": 0.8224,
       "y": 0.9032,
       "n": 31,
       "y_lo": 0.7991,
       "y_hi": 1.0
      }
     ],
     "spread_mae": {
      "value": 9.67958,
      "lo": 8.7743,
      "hi": 10.56491
     },
     "total_mae": {
      "value": 10.34507,
      "lo": 9.47981,
      "hi": 11.28744
     }
    },
    {
     "key": "ridge",
     "label": "Margin ridge",
     "n": 284,
     "log_loss": {
      "value": 0.63387,
      "lo": 0.59192,
      "hi": 0.68246
     },
     "accuracy": {
      "value": 0.64437,
      "lo": 0.58397,
      "hi": 0.69962
     },
     "brier": {
      "value": 0.22209,
      "lo": 0.20334,
      "hi": 0.24309
     },
     "calibration": [
      {
       "p": 0.2775,
       "y": 0.3125,
       "n": 32,
       "y_lo": 0.1519,
       "y_hi": 0.4731
      },
      {
       "p": 0.409,
       "y": 0.3125,
       "n": 32,
       "y_lo": 0.1519,
       "y_hi": 0.4731
      },
      {
       "p": 0.4765,
       "y": 0.4062,
       "n": 32,
       "y_lo": 0.2361,
       "y_hi": 0.5764
      },
      {
       "p": 0.518,
       "y": 0.4375,
       "n": 32,
       "y_lo": 0.2656,
       "y_hi": 0.6094
      },
      {
       "p": 0.5697,
       "y": 0.5938,
       "n": 32,
       "y_lo": 0.4236,
       "y_hi": 0.7639
      },
      {
       "p": 0.6252,
       "y": 0.5161,
       "n": 31,
       "y_lo": 0.3402,
       "y_hi": 0.6921
      },
      {
       "p": 0.6842,
       "y": 0.6129,
       "n": 31,
       "y_lo": 0.4414,
       "y_hi": 0.7844
      },
      {
       "p": 0.745,
       "y": 0.8387,
       "n": 31,
       "y_lo": 0.7092,
       "y_hi": 0.9682
      },
      {
       "p": 0.8423,
       "y": 0.8065,
       "n": 31,
       "y_lo": 0.6674,
       "y_hi": 0.9455
      }
     ],
     "spread_mae": {
      "value": 10.18131,
      "lo": 9.26322,
      "hi": 11.05138
     }
    },
    {
     "key": "drive_sim",
     "label": "Drive simulator (calibrated)",
     "n": 284,
     "log_loss": {
      "value": 0.63692,
      "lo": 0.59129,
      "hi": 0.68894
     },
     "accuracy": {
      "value": 0.64085,
      "lo": 0.58203,
      "hi": 0.69581
     },
     "brier": {
      "value": 0.22283,
      "lo": 0.20263,
      "hi": 0.24559
     },
     "calibration": [
      {
       "p": 0.2688,
       "y": 0.3438,
       "n": 32,
       "y_lo": 0.1792,
       "y_hi": 0.5083
      },
      {
       "p": 0.3862,
       "y": 0.1875,
       "n": 32,
       "y_lo": 0.0523,
       "y_hi": 0.3227
      },
      {
       "p": 0.467,
       "y": 0.5,
       "n": 32,
       "y_lo": 0.3268,
       "y_hi": 0.6732
      },
      {
       "p": 0.5237,
       "y": 0.5625,
       "n": 32,
       "y_lo": 0.3906,
       "y_hi": 0.7344
      },
      {
       "p": 0.5806,
       "y": 0.5,
       "n": 32,
       "y_lo": 0.3268,
       "y_hi": 0.6732
      },
      {
       "p": 0.6314,
       "y": 0.4516,
       "n": 31,
       "y_lo": 0.2764,
       "y_hi": 0.6268
      },
      {
       "p": 0.6815,
       "y": 0.7097,
       "n": 31,
       "y_lo": 0.5499,
       "y_hi": 0.8695
      },
      {
       "p": 0.736,
       "y": 0.7742,
       "n": 31,
       "y_lo": 0.627,
       "y_hi": 0.9214
      },
      {
       "p": 0.841,
       "y": 0.8065,
       "n": 31,
       "y_lo": 0.6674,
       "y_hi": 0.9455
      }
     ],
     "spread_mae": {
      "value": 10.21654,
      "lo": 9.2934,
      "hi": 11.08728
     },
     "total_mae": {
      "value": 10.46511,
      "lo": 9.52508,
      "hi": 11.3911
     }
    }
   ],
   "deltas": [
    {
     "model": "ridge",
     "reference": "market",
     "log_loss_gain": {
      "value": -0.02455,
      "lo": -0.04759,
      "hi": -0.00252
     },
     "p_better": 0.013
    },
    {
     "model": "drive_sim",
     "reference": "market",
     "log_loss_gain": {
      "value": -0.02759,
      "lo": -0.054,
      "hi": -0.00266
     },
     "p_better": 0.015
    }
   ]
  },
  {
   "key": "2024-25-fpi",
   "label": "2024-2025 with ESPN FPI",
   "n": 569,
   "note": "XGBoost here is a backfill with the EPA fix applied, not what production served; production ran without EPA all of 2025-26.",
   "source": "hanks_tank_ml scripts/football/eval_fpi_vs_models.py; ESPN core-API predictor (pregame gameProjection), backfilled XGBoost with the EPA fix",
   "block": "wk",
   "reference": "market",
   "models": [
    {
     "key": "market",
     "label": "Closing line (benchmark)",
     "n": 569,
     "log_loss": {
      "value": 0.59809,
      "lo": 0.57053,
      "hi": 0.6278
     },
     "accuracy": {
      "value": 0.68366,
      "lo": 0.64285,
      "hi": 0.72126
     },
     "brier": {
      "value": 0.20593,
      "lo": 0.19389,
      "hi": 0.21944
     },
     "calibration": [
      {
       "p": 0.232,
       "y": 0.2105,
       "n": 57,
       "y_lo": 0.1047,
       "y_hi": 0.3164
      },
      {
       "p": 0.3323,
       "y": 0.2807,
       "n": 57,
       "y_lo": 0.164,
       "y_hi": 0.3974
      },
      {
       "p": 0.3987,
       "y": 0.2982,
       "n": 57,
       "y_lo": 0.1795,
       "y_hi": 0.417
      },
      {
       "p": 0.4576,
       "y": 0.4737,
       "n": 57,
       "y_lo": 0.3441,
       "y_hi": 0.6033
      },
      {
       "p": 0.5299,
       "y": 0.5439,
       "n": 57,
       "y_lo": 0.4146,
       "y_hi": 0.6732
      },
      {
       "p": 0.5839,
       "y": 0.614,
       "n": 57,
       "y_lo": 0.4877,
       "y_hi": 0.7404
      },
      {
       "p": 0.6312,
       "y": 0.6842,
       "n": 57,
       "y_lo": 0.5635,
       "y_hi": 0.8049
      },
      {
       "p": 0.6947,
       "y": 0.7368,
       "n": 57,
       "y_lo": 0.6225,
       "y_hi": 0.8512
      },
      {
       "p": 0.7541,
       "y": 0.6667,
       "n": 57,
       "y_lo": 0.5443,
       "y_hi": 0.789
      },
      {
       "p": 0.8449,
       "y": 0.9107,
       "n": 56,
       "y_lo": 0.836,
       "y_hi": 0.9854
      }
     ]
    },
    {
     "key": "ridge",
     "label": "Margin ridge",
     "n": 569,
     "log_loss": {
      "value": 0.63134,
      "lo": 0.59935,
      "hi": 0.66373
     },
     "accuracy": {
      "value": 0.65026,
      "lo": 0.60737,
      "hi": 0.69449
     },
     "brier": {
      "value": 0.22054,
      "lo": 0.20629,
      "hi": 0.23481
     },
     "calibration": [
      {
       "p": 0.2778,
       "y": 0.3158,
       "n": 57,
       "y_lo": 0.1951,
       "y_hi": 0.4365
      },
      {
       "p": 0.3871,
       "y": 0.2982,
       "n": 57,
       "y_lo": 0.1795,
       "y_hi": 0.417
      },
      {
       "p": 0.4522,
       "y": 0.4211,
       "n": 57,
       "y_lo": 0.2929,
       "y_hi": 0.5492
      },
      {
       "p": 0.4967,
       "y": 0.386,
       "n": 57,
       "y_lo": 0.2596,
       "y_hi": 0.5123
      },
      {
       "p": 0.5398,
       "y": 0.5263,
       "n": 57,
       "y_lo": 0.3967,
       "y_hi": 0.6559
      },
      {
       "p": 0.5915,
       "y": 0.5614,
       "n": 57,
       "y_lo": 0.4326,
       "y_hi": 0.6902
      },
      {
       "p": 0.6376,
       "y": 0.6667,
       "n": 57,
       "y_lo": 0.5443,
       "y_hi": 0.789
      },
      {
       "p": 0.688,
       "y": 0.6667,
       "n": 57,
       "y_lo": 0.5443,
       "y_hi": 0.789
      },
      {
       "p": 0.7498,
       "y": 0.7368,
       "n": 57,
       "y_lo": 0.6225,
       "y_hi": 0.8512
      },
      {
       "p": 0.8401,
       "y": 0.8393,
       "n": 56,
       "y_lo": 0.7431,
       "y_hi": 0.9355
      }
     ]
    },
    {
     "key": "xgb",
     "label": "XGBoost (EPA fixed, backfilled)",
     "n": 569,
     "log_loss": {
      "value": 0.62574,
      "lo": 0.59537,
      "hi": 0.65562
     },
     "accuracy": {
      "value": 0.64675,
      "lo": 0.60545,
      "hi": 0.6875
     },
     "brier": {
      "value": 0.21857,
      "lo": 0.20474,
      "hi": 0.23202
     },
     "calibration": [
      {
       "p": 0.2784,
       "y": 0.3158,
       "n": 57,
       "y_lo": 0.1951,
       "y_hi": 0.4365
      },
      {
       "p": 0.3693,
       "y": 0.3158,
       "n": 57,
       "y_lo": 0.1951,
       "y_hi": 0.4365
      },
      {
       "p": 0.4321,
       "y": 0.3684,
       "n": 57,
       "y_lo": 0.2432,
       "y_hi": 0.4936
      },
      {
       "p": 0.4875,
       "y": 0.4737,
       "n": 57,
       "y_lo": 0.3441,
       "y_hi": 0.6033
      },
      {
       "p": 0.5404,
       "y": 0.4737,
       "n": 57,
       "y_lo": 0.3441,
       "y_hi": 0.6033
      },
      {
       "p": 0.5829,
       "y": 0.4912,
       "n": 57,
       "y_lo": 0.3614,
       "y_hi": 0.621
      },
      {
       "p": 0.6332,
       "y": 0.7193,
       "n": 57,
       "y_lo": 0.6026,
       "y_hi": 0.836
      },
      {
       "p": 0.7034,
       "y": 0.7018,
       "n": 57,
       "y_lo": 0.583,
       "y_hi": 0.8205
      },
      {
       "p": 0.7589,
       "y": 0.7018,
       "n": 57,
       "y_lo": 0.583,
       "y_hi": 0.8205
      },
      {
       "p": 0.861,
       "y": 0.8571,
       "n": 56,
       "y_lo": 0.7655,
       "y_hi": 0.9488
      }
     ]
    },
    {
     "key": "fpi",
     "label": "ESPN FPI (not a target)",
     "n": 569,
     "log_loss": {
      "value": 0.6279,
      "lo": 0.60641,
      "hi": 0.64927
     },
     "accuracy": {
      "value": 0.66608,
      "lo": 0.62285,
      "hi": 0.70966
     },
     "brier": {
      "value": 0.21888,
      "lo": 0.20873,
      "hi": 0.2289
     },
     "calibration": [
      {
       "p": 0.2895,
       "y": 0.3158,
       "n": 57,
       "y_lo": 0.1951,
       "y_hi": 0.4365
      },
      {
       "p": 0.3793,
       "y": 0.2632,
       "n": 57,
       "y_lo": 0.1488,
       "y_hi": 0.3775
      },
      {
       "p": 0.4259,
       "y": 0.3684,
       "n": 57,
       "y_lo": 0.2432,
       "y_hi": 0.4936
      },
      {
       "p": 0.4641,
       "y": 0.4737,
       "n": 57,
       "y_lo": 0.3441,
       "y_hi": 0.6033
      },
      {
       "p": 0.5056,
       "y": 0.5263,
       "n": 57,
       "y_lo": 0.3967,
       "y_hi": 0.6559
      },
      {
       "p": 0.5516,
       "y": 0.5088,
       "n": 57,
       "y_lo": 0.379,
       "y_hi": 0.6386
      },
      {
       "p": 0.6007,
       "y": 0.7018,
       "n": 57,
       "y_lo": 0.583,
       "y_hi": 0.8205
      },
      {
       "p": 0.6409,
       "y": 0.7193,
       "n": 57,
       "y_lo": 0.6026,
       "y_hi": 0.836
      },
      {
       "p": 0.6858,
       "y": 0.7544,
       "n": 57,
       "y_lo": 0.6426,
       "y_hi": 0.8661
      },
      {
       "p": 0.7752,
       "y": 0.7857,
       "n": 56,
       "y_lo": 0.6782,
       "y_hi": 0.8932
      }
     ]
    }
   ],
   "deltas": [
    {
     "model": "ridge",
     "reference": "market",
     "log_loss_gain": {
      "value": -0.03325,
      "lo": -0.04697,
      "hi": -0.01826
     },
     "p_better": 0.0
    },
    {
     "model": "xgb",
     "reference": "market",
     "log_loss_gain": {
      "value": -0.02765,
      "lo": -0.04186,
      "hi": -0.0136
     },
     "p_better": 0.0
    },
    {
     "model": "fpi",
     "reference": "market",
     "log_loss_gain": {
      "value": -0.02981,
      "lo": -0.04236,
      "hi": -0.01642
     },
     "p_better": 0.0
    }
   ]
  }
 ]
};
