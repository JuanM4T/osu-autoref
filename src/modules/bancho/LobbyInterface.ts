//

export interface LobbyInterface {
    connect(): Promise<void>;

    exit(): Promise<void>

    inviteAll(): Promise<void>;

    join(): Promise<void>;

    leave(): Promise<void>;

    name: string;
    players: string[];
    refs: string[];
    settings: {
        maxPlayers: number;
        password: string;
        gameRule: number;
        teamMode: number;
    };
}